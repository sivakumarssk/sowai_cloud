import type { EventBus } from "../core/EventBus";
import { subjectForService, type ContainerEventType, type EventInput } from "../core/events";
import type { EngineConfig } from "../config";
import { createLogger, type Logger } from "../log";
import { Poller } from "../core/poller";
import { nextLevel, sustained, type Level } from "./levels";

export { nextLevel, type Level };

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const SOURCE = "ContainerMonitor";

// ── Inputs ────────────────────────────────────────────────────────────

export type MonitoredNode = { id: string; name: string; ip: string };

/** One container as reported by Proxmox (GET /nodes/{node}/lxc). Sizes in bytes, cpu 0–1. */
export type RawContainer = {
  vmid: number;
  name?: string;
  status: string;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  cpu: number;
  cpus: number;
  netin: number;
  netout: number;
};

/** A container that belongs to an ACTIVE service. */
export type ManagedContainer = {
  vmid: number;
  serviceId: string;
  clientId: string;
  planRamMB: number | null;
  planDiskGB: number | null;
  planVcpu: number | null;
};

export type ContainerMonitorDeps = {
  listNodes(): Promise<MonitoredNode[]>;
  listContainers(node: MonitoredNode): Promise<RawContainer[]>;
  managedContainers(node: MonitoredNode): Promise<ManagedContainer[]>;
  /** Persist samples of managed, running containers (ResourceMetric). */
  saveSamples(samples: ContainerSample[]): Promise<void>;
};

// ── Output ────────────────────────────────────────────────────────────

export type ContainerSample = {
  nodeId: string;
  nodeName: string;
  vmid: number;
  name: string | null;
  /** Null for containers that don't belong to an active service (tests, templates, leftovers). */
  serviceId: string | null;
  clientId: string | null;

  memUsed: number;
  memLimit: number;
  memPlanLimit: number | null;
  memPct: number;

  /** 0–1 fraction of the container's cores. */
  cpuUsed: number;
  cpuCores: number;
  cpuPlanLimit: number | null;

  diskUsed: number;
  diskLimit: number;
  diskPlanLimit: number | null;
  diskPct: number;

  netIn: number;
  netOut: number;

  status: "running" | "stopped" | string;
  at: number;
};

export function toSample(node: MonitoredNode, raw: RawContainer, managed: ManagedContainer | undefined, at: number): ContainerSample {
  const pct = (used: number, limit: number) => (limit > 0 ? round1((used / limit) * 100) : 0);
  return {
    nodeId: node.id,
    nodeName: node.name,
    vmid: raw.vmid,
    name: raw.name ?? null,
    serviceId: managed?.serviceId ?? null,
    clientId: managed?.clientId ?? null,
    memUsed: raw.mem,
    memLimit: raw.maxmem,
    memPlanLimit: managed?.planRamMB ? managed.planRamMB * MB : null,
    memPct: pct(raw.mem, raw.maxmem),
    // Proxmox can report a small negative CPU delta (counter jitter) or a
    // spike above the core count; keep it within 0–100% of the container's cores.
    cpuUsed: clamp01(raw.cpu),
    cpuCores: raw.cpus,
    cpuPlanLimit: managed?.planVcpu ?? null,
    diskUsed: raw.disk,
    diskLimit: raw.maxdisk,
    diskPlanLimit: managed?.planDiskGB ? managed.planDiskGB * GB : null,
    diskPct: pct(raw.disk, raw.maxdisk),
    netIn: raw.netin,
    netOut: raw.netout,
    status: raw.status,
    at,
  };
}

// ── Threshold evaluation (pure) ───────────────────────────────────────

export type ContainerState = { ram: Level; disk: Level; cpuHighSince: number | null };
export const INITIAL_STATE: ContainerState = { ram: 0, disk: 0, cpuHighSince: null };

const RAM_TYPES: Record<1 | 2 | 3, ContainerEventType> = { 1: "RAM_WARNING", 2: "RAM_CRITICAL", 3: "RAM_EMERGENCY" };
const DISK_TYPES: Record<1 | 2 | 3, ContainerEventType> = { 1: "DISK_WARNING", 2: "DISK_CRITICAL", 3: "DISK_FULL" };

export type Evaluation = {
  events: EventInput[];
  /** Event types to re-arm on the bus because their level was left. */
  resets: ContainerEventType[];
  state: ContainerState;
};

/** Decides which events one sample produces. Only managed, running containers produce events. */
export function evaluateContainer(sample: ContainerSample, prev: ContainerState, config: EngineConfig, now: number): Evaluation {
  if (!sample.serviceId || sample.status !== "running") {
    // A stopped container clears its levels, so alerts fire again promptly after a restart.
    const resets: ContainerEventType[] = [];
    for (let l = 1; l <= prev.ram; l++) resets.push(RAM_TYPES[l as 1 | 2 | 3]);
    for (let l = 1; l <= prev.disk; l++) resets.push(DISK_TYPES[l as 1 | 2 | 3]);
    if (prev.cpuHighSince !== null) resets.push("CPU_HIGH");
    return { events: [], resets: sample.serviceId ? resets : [], state: INITIAL_STATE };
  }
  const serviceId = sample.serviceId;
  const subject = subjectForService(serviceId);
  const base = { vmid: sample.vmid, serviceId, nodeId: sample.nodeId };
  const events: EventInput[] = [];
  const resets: ContainerEventType[] = [];

  const level = (
    pct: number,
    current: Level,
    thresholds: readonly [number, number, number],
    types: Record<1 | 2 | 3, ContainerEventType>,
    data: { used: number; limit: number; unit: "MB" | "GB" }
  ): Level => {
    const next = nextLevel(pct, current, thresholds, config.hysteresisPct);
    if (next > 0) {
      events.push({ type: types[next as 1 | 2 | 3], subject, source: SOURCE, data: { ...base, pct, ...data } } as EventInput);
    }
    // Leaving a level re-arms it (and anything above) for the next crossing.
    for (let l = next + 1; l <= current; l++) resets.push(types[l as 1 | 2 | 3]);
    return next;
  };

  const ram = level(
    sample.memPct,
    prev.ram,
    [config.ramWarningPct, config.ramCriticalPct, config.ramEmergencyPct],
    RAM_TYPES,
    { used: Math.round(sample.memUsed / MB), limit: Math.round(sample.memLimit / MB), unit: "MB" }
  );
  const disk = level(
    sample.diskPct,
    prev.disk,
    [config.diskWarningPct, config.diskCriticalPct, config.diskFullPct],
    DISK_TYPES,
    { used: round1(sample.diskUsed / GB), limit: round1(sample.diskLimit / GB), unit: "GB" }
  );

  const cpuPct = round1(sample.cpuUsed * 100);
  const cpu = sustained(cpuPct, prev.cpuHighSince, now, config.cpuAlertPct, config.cpuAlertDurationMs, config.hysteresisPct);
  if (cpu.firingMs !== null) {
    events.push({
      type: "CPU_HIGH",
      subject,
      source: SOURCE,
      data: { ...base, pct: cpuPct, used: cpuPct, limit: 100, unit: "%", sustainedSeconds: Math.round(cpu.firingMs / 1000) },
    });
  }
  if (cpu.cleared) resets.push("CPU_HIGH");

  return { events, resets, state: { ram, disk, cpuHighSince: cpu.since } };
}

// ── Monitor ───────────────────────────────────────────────────────────

export type ContainerMonitorStats = {
  polls: number;
  lastPollAt: number | null;
  lastPollMs: number | null;
  containers: number;
  managed: number;
  eventsPublished: number;
  /** Nodes whose last poll failed, with the error. */
  nodeErrors: Record<string, string>;
};

/**
 * Polls every node's containers on an interval, records metrics and publishes
 * threshold events. Never decides or acts — that's the DecisionMaker's job.
 */
export class ContainerMonitor {
  private readonly states = new Map<string, ContainerState>();
  private readonly latest = new Map<string, ContainerSample>();
  private readonly poller: Poller<ContainerSample[]>;
  private readonly counters: ContainerMonitorStats = {
    polls: 0,
    lastPollAt: null,
    lastPollMs: null,
    containers: 0,
    managed: 0,
    eventsPublished: 0,
    nodeErrors: {},
  };
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(
    private readonly bus: EventBus,
    private readonly deps: ContainerMonitorDeps,
    private readonly config: EngineConfig,
    options: { log?: Logger; now?: () => number } = {}
  ) {
    this.log = options.log ?? createLogger("containers");
    this.now = options.now ?? Date.now;
    this.poller = new Poller(() => this.runPoll(), config.containerPollMs, this.log);
  }

  /** Polls immediately, then every containerPollMs. Polls never overlap. */
  start(): void {
    this.poller.start();
  }

  stop(): Promise<void> {
    return this.poller.stop();
  }

  /** One full pass over every node. Returns all samples (managed and unmanaged). */
  pollOnce(): Promise<ContainerSample[]> {
    return this.poller.pollOnce();
  }

  /** Latest sample per container. */
  snapshot(): ContainerSample[] {
    return [...this.latest.values()].sort((a, b) => a.nodeName.localeCompare(b.nodeName) || a.vmid - b.vmid);
  }

  stats(): ContainerMonitorStats {
    return { ...this.counters, nodeErrors: { ...this.counters.nodeErrors } };
  }

  private async runPoll(): Promise<ContainerSample[]> {
    const started = this.now();
    const nodes = await this.deps.listNodes();
    const perNode = await Promise.allSettled(nodes.map((node) => this.pollNode(node, started)));

    const samples: ContainerSample[] = [];
    perNode.forEach((result, i) => {
      const node = nodes[i];
      if (result.status === "fulfilled") {
        delete this.counters.nodeErrors[node.name];
        samples.push(...result.value);
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.counters.nodeErrors[node.name] = message;
        this.log.warn(`node ${node.name} unreachable: ${message}`);
      }
    });

    // Forget containers that disappeared from nodes we could reach.
    const reached = new Set(nodes.filter((_, i) => perNode[i].status === "fulfilled").map((n) => n.id));
    const seen = new Set(samples.map(key));
    for (const [k, sample] of this.latest) {
      if (reached.has(sample.nodeId) && !seen.has(k)) {
        this.latest.delete(k);
        this.states.delete(k);
      }
    }

    const toSave = samples.filter((s) => s.serviceId && s.status === "running");
    if (toSave.length > 0) {
      await this.deps.saveSamples(toSave).catch((err) => this.log.error("saving metrics failed:", err));
    }

    this.counters.polls++;
    this.counters.lastPollAt = started;
    this.counters.lastPollMs = this.now() - started;
    this.counters.containers = this.latest.size;
    this.counters.managed = [...this.latest.values()].filter((s) => s.serviceId).length;
    return samples;
  }

  private async pollNode(node: MonitoredNode, at: number): Promise<ContainerSample[]> {
    const [raw, managed] = await Promise.all([this.deps.listContainers(node), this.deps.managedContainers(node)]);
    const byVmid = new Map(managed.map((m) => [m.vmid, m]));

    return raw.map((container) => {
      const sample = toSample(node, container, byVmid.get(container.vmid), at);
      const k = key(sample);
      const prev = this.states.get(k) ?? INITIAL_STATE;
      const { events, resets, state } = evaluateContainer(sample, prev, this.config, at);

      if (sample.serviceId) {
        const subject = subjectForService(sample.serviceId);
        for (const type of resets) this.bus.reset(subject, type);
      }
      for (const event of events) {
        if (this.bus.publish(event)) this.counters.eventsPublished++;
      }
      this.states.set(k, state);
      this.latest.set(k, sample);
      return sample;
    });
  }
}

const key = (s: Pick<ContainerSample, "nodeId" | "vmid">) => `${s.nodeId}:${s.vmid}`;
const round1 = (n: number) => Math.round(n * 10) / 10;
/** 0–1, treating NaN/negative as 0. */
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
