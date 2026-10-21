import type { Logger } from "../log";

/**
 * Runs `poll` now and then every `intervalMs`, never overlapping. A manual
 * pollOnce() while a poll is running joins it instead of starting another.
 */
export class Poller<T> {
  private timer: NodeJS.Timeout | null = null;
  private inProgress: Promise<T> | null = null;
  private stopped = true;

  constructor(
    private readonly poll: () => Promise<T>,
    private readonly intervalMs: number,
    private readonly log: Logger
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      await this.pollOnce().catch((err) => this.log.error("poll failed:", err));
      if (!this.stopped) this.timer = setTimeout(loop, this.intervalMs);
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inProgress?.catch(() => {});
  }

  pollOnce(): Promise<T> {
    this.inProgress ??= this.poll().finally(() => (this.inProgress = null));
    return this.inProgress;
  }
}
