import type { EngineConfig } from "../config";
import type { ContainerTarget } from "../actions/types";
import type { RamScaler } from "../actions/RamScaler";
import type { DiskExpander } from "../actions/DiskExpander";
import { createLogger, type Logger } from "../log";
import type { Decision } from "./decisions";
import type { EventBus } from "./EventBus";
import { isContainerEvent, subjectForNode, subjectForService, type EngineEvent, type ContainerEventType, type ServerEventType } from "./events";
import type { ExecutionOutcome } from "./ActionExecutor";

export type NodeState = {
  name: string;
  /** Physical RAM in use, % (from the ServerMonitor). Null when unknown or stale. */
  ramPct: number | null;
  acceptNewClients: boolean;
  /** What another server like this one costs per month, paise. */
  monthlyCostPaise: number;
};

export type DecisionMakerDeps = {
  nodeState(nodeId: string): Promise<NodeState | null>;
  target(serviceId: string): Promise<ContainerTarget>;
  /** Read-only planning — nothing here changes anything. */
  ramScaler: Pick<RamScaler, "plan">;
  diskExpander: Pick<DiskExpander, "plan">;
  /** Hands each decision to the ActionExecutor (policy gate → log / approval / run). */
  submit(decision: Decision): Promise<ExecutionOutcome>;
};

export type DecisionConfig = Pick<EngineConfig, "ramExpandChunkMB" | "diskExpandChunkGB" | "volumeCostPerGbPaise"> & {
  /** Size of a Volume the engine proposes buying. */
  volumeSizeGB: number;
};

/** Node RAM below this: scale a container by a full chunk. */
const NODE_RAM_ROOMY = 70;
/** Node RAM below this: scale by half a chunk; above it, don't add RAM on this node. */
const NODE_RAM_TIGHT = 80;

const SERVER_EVENT_TITLES: Partial<Record<ServerEventType, string>> = {
  SERVER_RAM_CRITICAL: "RAM critical",
  SERVER_DISK_CRITICAL: "disk critical",
  SERVER_FULL: "server full",
};

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

/**
 * Turns monitor events into proposed actions. It only plans (reading current
 * state); every decision goes to the ActionExecutor, whose policy gate decides
 * whether it's logged, sent for approval, recommended or run. In OBSERVE mode
 * that means: logged only.
 */
export class DecisionMaker {
  private readonly log: Logger;
  private readonly counters = { events: 0, decisions: 0, skippedBusy: 0, errors: 0 };

  constructor(
    private readonly deps: DecisionMakerDeps,
    private readonly config: DecisionConfig,
    options: { log?: Logger } = {}
  ) {
    this.log = options.log ?? createLogger("decisions");
  }

  /**
   * Listen to every event. Events for the same subject are handled one after
   * another (queued, never dropped — a repeat wouldn't arrive again until the
   * bus's de-duplication window has passed).
   */
  attach(bus: EventBus, onResult?: (event: EngineEvent, results: { decision: Decision; outcome: ExecutionOutcome }[]) => void): () => void {
    return bus.subscribe("*", (event) => {
      const previous = this.queues.get(event.subject) ?? Promise.resolve();
      const next = previous.then(async () => {
        // The lock also keeps out anything else acting on this subject through the bus.
        const run = await bus.runExclusive(event.subject, () => this.handle(event));
        if (!run.ran) {
          this.counters.skippedBusy++;
          this.log.warn(`${event.type} ${event.subject}: another action holds this subject — skipped`);
          return;
        }
        onResult?.(event, run.result);
      });
      const tail = next.catch(() => {});
      this.queues.set(event.subject, tail);
      void tail.finally(() => {
        if (this.queues.get(event.subject) === tail) this.queues.delete(event.subject);
      });
      return next;
    });
  }

  private readonly queues = new Map<string, Promise<void>>();

  stats() {
    return { ...this.counters };
  }

  /** Decides and submits. Returns what happened to each decision. */
  async handle(event: EngineEvent): Promise<{ decision: Decision; outcome: ExecutionOutcome }[]> {
    this.counters.events++;
    let decisions: Decision[];
    try {
      decisions = await this.decide(event);
    } catch (err) {
      this.counters.errors++;
      this.log.error(`could not decide on ${event.type} ${event.subject}:`, err);
      return [];
    }
    const results = [];
    for (const decision of decisions) {
      this.counters.decisions++;
      results.push({ decision, outcome: await this.deps.submit(decision) });
    }
    return results;
  }

  /** The rules. Pure planning: reads state, changes nothing. */
  async decide(event: EngineEvent): Promise<Decision[]> {
    if (isContainerEvent(event)) return this.decideContainer(event);
    return this.decideServer(event as EngineEvent<ServerEventType>);
  }

  private async decideContainer(event: EngineEvent<ContainerEventType>): Promise<Decision[]> {
    const { serviceId, nodeId, pct } = event.data;
    const subject = subjectForService(serviceId);
    const reason = `${event.type}: ${pct}% (${event.data.used}/${event.data.limit} ${event.data.unit}) on service ${serviceId}`;

    switch (event.type) {
      case "RAM_WARNING":
      case "DISK_WARNING":
      case "CPU_HIGH":
        // Watched, not acted on.
        return [];

      case "RAM_CRITICAL":
      case "RAM_EMERGENCY": {
        const node = await this.deps.nodeState(nodeId);
        const nodeRam = node?.ramPct ?? null;
        const nodeName = node?.name ?? nodeId;
        const emergency = event.type === "RAM_EMERGENCY";
        const target = await this.deps.target(serviceId);

        let addMB: number | null = null;
        if (nodeRam !== null && nodeRam < NODE_RAM_ROOMY) addMB = this.config.ramExpandChunkMB;
        else if (nodeRam !== null && nodeRam < NODE_RAM_TIGHT) addMB = emergency ? this.config.ramExpandChunkMB : Math.round(this.config.ramExpandChunkMB / 2);

        if (addMB !== null) {
          const plan = await this.deps.ramScaler.plan(target, { addMB, reason });
          if (plan.ok) {
            return [{ kind: "RAM_SCALE", subject, summary: plan.summary, reason: `${reason}; node RAM ${nodeRam}%`, monthlyCostPaise: 0, payload: { kind: "RAM_SCALE", serviceId, addMB } }];
          }
          if (plan.code !== "AT_RAM_CEILING") return [];
          return [
            this.notify(serviceId, "UPGRADE_RAM", reason, `RAM is at the ${plan.reason.replace(/^already at the /, "")}`),
            ...(emergency ? [this.alert(subject, `Service ${serviceId} out of RAM at its ceiling`, `${reason}\n${plan.reason}`)] : []),
          ];
        }

        // Node itself is tight (or unknown): don't add RAM here.
        const why = nodeRam === null ? `node ${nodeName} RAM usage is unknown` : `node ${nodeName} is at ${nodeRam}% RAM`;
        if (emergency) {
          return [
            {
              kind: "MIGRATION",
              subject,
              summary: `move service ${serviceId} (container ${target.vmid}) off ${nodeName} tonight`,
              reason: `${reason}; ${why}`,
              monthlyCostPaise: 0,
              payload: { kind: "MIGRATION", serviceId, nodeName, urgency: "TONIGHT", detail: why },
            },
            this.alert(subject, `Service ${serviceId} out of RAM on a full node`, `${reason}\n${why} — no RAM added. Migration proposed.`),
          ];
        }
        return [
          this.notify(serviceId, "UPGRADE_RAM", reason, why),
          this.alert(subject, `Service ${serviceId} needs RAM, ${nodeName} has none to spare`, `${reason}\n${why} — no RAM added.`),
        ];
      }

      case "DISK_CRITICAL":
      case "DISK_FULL": {
        const full = event.type === "DISK_FULL";
        const target = await this.deps.target(serviceId);
        const plan = await this.deps.diskExpander.plan(target, { purpose: "EXTRA_SPACE", addGB: this.config.diskExpandChunkGB, reason });
        if (plan.ok) {
          return [{ kind: "DISK_EXPAND", subject, summary: plan.summary, reason, monthlyCostPaise: plan.monthlyCostPaise, payload: { kind: "DISK_EXPAND", serviceId, purpose: "EXTRA_SPACE", addGB: plan.addGB } }];
        }
        if (plan.code === "OVERAGE_NOT_ENABLED") {
          return [this.notify(serviceId, full ? "STORAGE_FULL" : "STORAGE_ALMOST_FULL", reason, `${pct}% of ${event.data.limit} GB used`)];
        }
        if (plan.code === "NEEDS_VOLUME") {
          const nodeName = target.node.name;
          const cost = this.config.volumeSizeGB * this.config.volumeCostPerGbPaise;
          return [
            {
              kind: "VOLUME_PURCHASE",
              subject: subjectForNode(nodeName),
              summary: `buy a ${this.config.volumeSizeGB} GB Hetzner Volume for ${nodeName} (${rupees(cost)}/month)`,
              reason: `${reason}; ${plan.reason}`,
              monthlyCostPaise: cost,
              payload: { kind: "VOLUME_PURCHASE", nodeName, sizeGB: this.config.volumeSizeGB },
            },
            this.alert(subject, `No disk space left on ${nodeName} for service ${serviceId}`, `${reason}\n${plan.reason}`),
          ];
        }
        return [this.alert(subject, `Can't add disk for service ${serviceId}`, `${reason}\n${plan.reason}`)];
      }
    }
  }

  private async decideServer(event: EngineEvent<ServerEventType>): Promise<Decision[]> {
    const { nodeId, nodeName, pct, resource } = event.data;
    const subject = subjectForNode(nodeName);
    const reason = `${event.type}: ${resource} at ${pct}% on ${nodeName}`;
    const node = await this.deps.nodeState(nodeId);
    const stop = (): Decision[] =>
      node && !node.acceptNewClients
        ? []
        : [{ kind: "STOP_SIGNUPS", subject, summary: `stop placing new clients on ${nodeName}`, reason, monthlyCostPaise: 0, payload: { kind: "STOP_SIGNUPS", nodeName } }];

    switch (event.type) {
      case "SERVER_RAM_WARNING":
      case "SERVER_DISK_WARNING":
        return [];

      case "SERVER_RAM_CRITICAL":
      case "SERVER_DISK_CRITICAL":
      case "SERVER_FULL":
        return [
          ...stop(),
          this.alert(subject, `${nodeName}: ${SERVER_EVENT_TITLES[event.type]} (${resource} ${pct}%)`, `${reason}\nNew clients go elsewhere until it's back under the limit.`),
        ];

      case "SERVER_RAM_EMERGENCY": {
        const cost = node?.monthlyCostPaise ?? 0;
        return [
          {
            kind: "SERVER_PURCHASE",
            subject,
            summary: `buy another server like ${nodeName}${cost ? ` (${rupees(cost)}/month)` : ""}`,
            reason,
            monthlyCostPaise: cost,
            payload: { kind: "SERVER_PURCHASE", nodeName },
          },
          ...stop(),
          {
            kind: "MIGRATION",
            subject,
            summary: `move the busiest containers off ${nodeName}`,
            reason,
            monthlyCostPaise: 0,
            payload: { kind: "MIGRATION", nodeName, urgency: "PLANNED", detail: `${resource} at ${pct}%` },
          },
          this.alert(subject, `${nodeName}: RAM emergency (${pct}%)`, `${reason}\nProposed: new server, stop signups, migrate containers.`),
        ];
      }

      case "SERVER_OVERLOADED":
        return [this.alert(subject, `${nodeName}: CPU overloaded`, `${reason}${event.data.sustainedSeconds ? ` for ${event.data.sustainedSeconds}s` : ""}`)];
    }
  }

  private notify(serviceId: string, template: Extract<Decision["payload"], { kind: "NOTIFY_CLIENT" }>["template"], reason: string, detail: string): Decision {
    return {
      kind: "NOTIFY_CLIENT",
      subject: subjectForService(serviceId),
      summary: `email the client of service ${serviceId}: ${template.toLowerCase().replace(/_/g, " ")}`,
      reason,
      monthlyCostPaise: 0,
      payload: { kind: "NOTIFY_CLIENT", serviceId, template, detail },
    };
  }

  private alert(subject: string, title: string, detail: string): Decision {
    return { kind: "ALERT_ADMIN", subject, summary: `alert admin: ${title}`, reason: detail.split("\n")[0], monthlyCostPaise: 0, payload: { kind: "ALERT_ADMIN", title, detail } };
  }
}
