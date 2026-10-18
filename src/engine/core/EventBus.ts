import { randomUUID } from "node:crypto";
import type { EngineEvent, EngineEventType, EventInput } from "./events";

type Handler<T extends EngineEventType = EngineEventType> = (event: EngineEvent<T>) => void | Promise<void>;
type Topic = EngineEventType | "*";

export type EventBusOptions = {
  /** Clock (epoch ms); injectable for tests. */
  now?: () => number;
  /** Drop a repeat of the same type + subject within this window. Default 5 minutes. */
  defaultDedupeMs?: number;
  /** Per-type override of the de-duplication window. */
  dedupeMs?: Partial<Record<EngineEventType, number>>;
  /** How many recent events to keep for the admin API. Default 200. */
  recentLimit?: number;
  /** Called when a handler throws; defaults to console.error. */
  onHandlerError?: (err: unknown, event: EngineEvent) => void;
};

export type EventBusStats = {
  published: number;
  delivered: number;
  deduplicated: number;
  handlerErrors: number;
  /** runExclusive calls skipped because an action for the same key was already running. */
  skippedBusy: number;
  byType: Record<string, number>;
  inFlight: string[];
};

const DEFAULT_DEDUPE_MS = 5 * 60_000;

/**
 * In-process pub/sub between monitors and the DecisionMaker.
 *
 * - Handlers run asynchronously after publish() returns, and a throwing
 *   handler never affects other handlers or the publisher.
 * - The same event type for the same subject is delivered at most once per
 *   de-duplication window, so a container sitting at 90% RAM doesn't trigger
 *   an action every 30 seconds. A different (e.g. more severe) type for the
 *   same subject is a different key and goes through.
 * - runExclusive() guarantees at most one action per key at a time.
 */
export class EventBus {
  private readonly handlers = new Map<Topic, Set<Handler>>();
  private readonly lastDelivered = new Map<string, number>();
  private readonly running = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly recent: EngineEvent[] = [];
  private readonly counters = { published: 0, delivered: 0, deduplicated: 0, handlerErrors: 0, skippedBusy: 0 };
  private readonly byType = new Map<string, number>();

  private readonly now: () => number;
  private readonly defaultDedupeMs: number;
  private readonly dedupeMs: Partial<Record<EngineEventType, number>>;
  private readonly recentLimit: number;
  private readonly onHandlerError: (err: unknown, event: EngineEvent) => void;

  constructor(options: EventBusOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultDedupeMs = options.defaultDedupeMs ?? DEFAULT_DEDUPE_MS;
    this.dedupeMs = options.dedupeMs ?? {};
    this.recentLimit = options.recentLimit ?? 200;
    this.onHandlerError =
      options.onHandlerError ?? ((err, event) => console.error(`[engine:bus] handler failed for ${event.type} ${event.subject}:`, err));
  }

  /** Subscribe to one event type, or "*" for all. Returns an unsubscribe function. */
  subscribe<T extends EngineEventType>(topic: T | "*", handler: Handler<T>): () => void {
    let set = this.handlers.get(topic);
    if (!set) this.handlers.set(topic, (set = new Set()));
    set.add(handler as Handler);
    return () => {
      set.delete(handler as Handler);
    };
  }

  /**
   * Publishes an event. Returns the event, or null if it was dropped as a
   * duplicate. Handlers run after this returns.
   */
  publish(input: EventInput): EngineEvent | null {
    const at = this.now();
    const key = dedupeKey(input.type, input.subject);
    const last = this.lastDelivered.get(key);
    const window = this.dedupeMs[input.type] ?? this.defaultDedupeMs;
    if (last !== undefined && at - last < window) {
      this.counters.deduplicated++;
      return null;
    }
    this.lastDelivered.set(key, at);
    this.pruneDedupe(at);

    const event = { ...input, id: randomUUID(), at } as EngineEvent;
    this.counters.published++;
    this.byType.set(event.type, (this.byType.get(event.type) ?? 0) + 1);
    this.recent.push(event);
    if (this.recent.length > this.recentLimit) this.recent.shift();

    const targets = [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get("*") ?? [])];
    for (const handler of targets) {
      const run = this.deliver(handler, event);
      this.pending.add(run);
      void run.finally(() => this.pending.delete(run));
    }
    return event;
  }

  /**
   * Re-arms an event for a subject, e.g. when usage drops back below the
   * threshold, so the next crossing is delivered without waiting for the
   * de-duplication window. Without a type, re-arms every type for the subject.
   */
  reset(subject: string, type?: EngineEventType): void {
    if (type) {
      this.lastDelivered.delete(dedupeKey(type, subject));
      return;
    }
    for (const key of this.lastDelivered.keys()) {
      if (key.endsWith(`|${subject}`)) this.lastDelivered.delete(key);
    }
  }

  /**
   * Runs fn unless another call with the same key is still running, in which
   * case it is skipped. Use one key per container / node so two decisions
   * can never act on the same thing at once.
   */
  async runExclusive<R>(key: string, fn: () => Promise<R>): Promise<{ ran: true; result: R } | { ran: false }> {
    if (this.running.has(key)) {
      this.counters.skippedBusy++;
      return { ran: false };
    }
    this.running.add(key);
    try {
      return { ran: true, result: await fn() };
    } finally {
      this.running.delete(key);
    }
  }

  /** Resolves once every handler started so far has finished (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  stats(): EventBusStats {
    return {
      ...this.counters,
      byType: Object.fromEntries(this.byType),
      inFlight: [...this.running],
    };
  }

  /** Most recent events, newest first. */
  recentEvents(limit = 50): EngineEvent[] {
    return this.recent.slice(-limit).reverse();
  }

  private async deliver(handler: Handler, event: EngineEvent): Promise<void> {
    // Never run handlers inside publish(): a handler that publishes must not re-enter.
    await Promise.resolve();
    try {
      await handler(event);
      this.counters.delivered++;
    } catch (err) {
      this.counters.handlerErrors++;
      this.onHandlerError(err, event);
    }
  }

  /** Forget de-duplication entries older than the longest window, so the map can't grow forever. */
  private pruneDedupe(at: number): void {
    if (this.lastDelivered.size < 1000) return;
    const longest = Math.max(this.defaultDedupeMs, ...Object.values(this.dedupeMs).map(Number));
    for (const [key, time] of this.lastDelivered) {
      if (at - time >= longest) this.lastDelivered.delete(key);
    }
  }
}

function dedupeKey(type: EngineEventType, subject: string): string {
  return `${type}|${subject}`;
}
