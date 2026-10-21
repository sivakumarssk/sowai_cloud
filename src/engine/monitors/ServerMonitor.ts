import type { EventBus } from "../core/EventBus";
import { subjectForNode, type EventInput, type ServerEventType } from "../core/events";
import type { EngineConfig } from "../config";
import { createLogger, type Logger } from "../log";
import { Poller } from "../core/poller";
import { nextLevel, sustained, type Level } from "./levels";

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const SOURCE = "ServerMonitor";

// ── Inputs ────────────────────────────────────────────────────────────

export type ServerNode = {
  id: string;
  name: string;
  ip: string;
  hetznerServerId: string;
  /** Hetzner Volumes attached to this node that Proxmox can use (have a storage ID). */
  volumes: { id: string; storage: string; sizeGB: number }[];
};

export type NodeReading = {
  memory: { total: number; used: number };
  /** 0–1 fraction of all host cores. */
  cpu: number;
  cpus: number;
};

export type StorageReading = { total: number; used: number };
export type DiskImage = { vmid: number | null; size: number };
export type NodeContainer = { vmid: number; status: string; maxmem: number };

export type NodeUpdate = {
  nodeId: string;
  usedRamMB: number;
  usedDiskGB: number;
  usedCpuPct: number;
  allocatedRamMB: number;
  allocatedDiskGB: number;
  containerCount: number;
  health: ServerHealth;
  volumes: { id: string; usedGB: number }[];
  at: number;
};

export type ServerMonitorDeps = {
  listNodes(): Promise<ServerNode[]>;
  nodeStatus(node: ServerNode): Promise<NodeReading>;
  storageStatus(node: ServerNode, storage: string): Promise<StorageReading>;
  /** Disk images on a storage with their allocated size (root disks and mount points). */
  storageImages(node: ServerNode, storage: string): Promise<DiskImage[]>;
  containers(node: ServerNode): Promise<NodeContainer[]>;
  saveNode(update: NodeUpdate): Promise<void>;
};

// ── Output ────────────────────────────────────────────────────────────

export type ServerHealth = "healthy" | "warning" | "critical";

export type VolumeSample = { id: string; storage: string; sizeBytes: number; usedBytes: number; allocatedBytes: number };

export type ServerSample = {
  nodeId: string;
  nodeName: string;
  hetznerServerId: string;

  physicalRam: number;
  physicalRamUsed: number;
  physicalRamPct: number;

  /** Container storage: size, bytes actually written, bytes promised to containers. */
  physicalDisk: number;
  physicalDiskUsed: number;
  physicalDiskPct: number;
  allocatedDisk: number;
  /** Space that can still be handed out from the free pool (after the reserve). */
  freePoolBytes: number;

  physicalCpu: number;
  physicalCpuPct: number;

  totalContainers: number;
  activeContainers: number;
  allocatedRam: number;

  volumes: VolumeSample[];
  volumeTotalSpace: number;
  volumeUsedSpace: number;

  status: ServerHealth;
  at: number;
};

/** Free-pool space left after the reserve, in bytes (never negative). */
export function freePoolBytes(totalBytes: number, allocatedBytes: number, reserveGB: number): number {
  return Math.max(0, totalBytes - allocatedBytes - reserveGB * GB);
}

// ── Threshold evaluation (pure) ───────────────────────────────────────

export type ServerState = { ram: Level; disk: Level; full: Level; cpuSince: number | null };
export const INITIAL_SERVER_STATE: ServerState = { ram: 0, disk: 0, full: 0, cpuSince: null };

const RAM_TYPES: ServerEventType[] = ["SERVER_RAM_WARNING", "SERVER_RAM_CRITICAL", "SERVER_RAM_EMERGENCY"];
const DISK_TYPES: ServerEventType[] = ["SERVER_DISK_WARNING", "SERVER_DISK_CRITICAL"];

export type ServerEvaluation = { events: EventInput[]; resets: ServerEventType[]; state: ServerState; health: ServerHealth };

export function evaluateServer(sample: ServerSample, prev: ServerState, config: EngineConfig, now: number): ServerEvaluation {
  const subject = subjectForNode(sample.nodeName);
  const base = { nodeId: sample.nodeId, nodeName: sample.nodeName };
  const events: EventInput[] = [];
  const resets: ServerEventType[] = [];

  const track = (
    pct: number,
    current: Level,
    thresholds: number[],
    types: ServerEventType[],
    resource: "RAM" | "DISK" | "CPU"
  ): Level => {
    const next = nextLevel(pct, current, thresholds, config.hysteresisPct);
    if (next > 0) events.push({ type: types[next - 1], subject, source: SOURCE, data: { ...base, pct, resource } } as EventInput);
    for (let l = next + 1; l <= current; l++) resets.push(types[l - 1]);
    return next;
  };

  const ram = track(sample.physicalRamPct, prev.ram, [config.serverWarningPct, config.serverCriticalPct, config.serverEmergencyPct], RAM_TYPES, "RAM");
  const disk = track(sample.physicalDiskPct, prev.disk, [config.serverWarningPct, config.serverCriticalPct], DISK_TYPES, "DISK");
  const fullResource = sample.physicalRamPct >= sample.physicalDiskPct ? "RAM" : "DISK";
  const full = track(Math.max(sample.physicalRamPct, sample.physicalDiskPct), prev.full, [config.serverFullPct], ["SERVER_FULL"], fullResource);

  const cpu = sustained(sample.physicalCpuPct, prev.cpuSince, now, config.serverCpuPct, config.serverCpuDurationMs, config.hysteresisPct);
  if (cpu.firingMs !== null) {
    events.push({
      type: "SERVER_OVERLOADED",
      subject,
      source: SOURCE,
      data: { ...base, pct: sample.physicalCpuPct, resource: "CPU", sustainedSeconds: Math.round(cpu.firingMs / 1000) },
    });
  }
  if (cpu.cleared) resets.push("SERVER_OVERLOADED");

  const health: ServerHealth =
    ram >= 2 || disk >= 2 || full >= 1 || cpu.firingMs !== null ? "critical" : ram >= 1 || disk >= 1 ? "warning" : "healthy";
  return { events, resets, state: { ram, disk, full, cpuSince: cpu.since }, health };
}

// ── Monitor ───────────────────────────────────────────────────────────

export type ServerMonitorStats = {
  polls: number;
  lastPollAt: number | null;
  lastPollMs: number | null;
  eventsPublished: number;
  nodeErrors: Record<string, string>;
};

/**
 * Polls each node's physical capacity and allocation, saves it on the
 * ProxmoxNode row and publishes server events. Never acts.
 */
export class ServerMonitor {
  private readonly states = new Map<string, ServerState>();
  private readonly latest = new Map<string, ServerSample>();
  private readonly poller: Poller<ServerSample[]>;
  private readonly counters: ServerMonitorStats = { polls: 0, lastPollAt: null, lastPollMs: null, eventsPublished: 0, nodeErrors: {} };
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(
    private readonly bus: EventBus,
    private readonly deps: ServerMonitorDeps,
    private readonly config: EngineConfig,
    options: { log?: Logger; now?: () => number } = {}
  ) {
    this.log = options.log ?? createLogger("servers");
    this.now = options.now ?? Date.now;
    this.poller = new Poller(() => this.runPoll(), config.serverPollMs, this.log);
  }

  start(): void {
    this.poller.start();
  }

  stop(): Promise<void> {
    return this.poller.stop();
  }

  pollOnce(): Promise<ServerSample[]> {
    return this.poller.pollOnce();
  }

  snapshot(): ServerSample[] {
    return [...this.latest.values()].sort((a, b) => a.nodeName.localeCompare(b.nodeName));
  }

  stats(): ServerMonitorStats {
    return { ...this.counters, nodeErrors: { ...this.counters.nodeErrors } };
  }

  private async runPoll(): Promise<ServerSample[]> {
    const started = this.now();
    const nodes = await this.deps.listNodes();
    const results = await Promise.allSettled(nodes.map((node) => this.pollNode(node, started)));

    const samples: ServerSample[] = [];
    results.forEach((r, i) => {
      const node = nodes[i];
      if (r.status === "fulfilled") {
        delete this.counters.nodeErrors[node.name];
        samples.push(r.value);
      } else {
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        this.counters.nodeErrors[node.name] = message;
        this.log.warn(`node ${node.name} unreachable: ${message}`);
      }
    });

    const known = new Set(nodes.map((n) => n.id));
    for (const id of this.latest.keys()) {
      if (!known.has(id)) {
        this.latest.delete(id);
        this.states.delete(id);
      }
    }

    this.counters.polls++;
    this.counters.lastPollAt = started;
    this.counters.lastPollMs = this.now() - started;
    return samples;
  }

  private async pollNode(node: ServerNode, at: number): Promise<ServerSample> {
    const storage = this.config.containerStorage;
    const [status, disk, images, containers, volumes] = await Promise.all([
      this.deps.nodeStatus(node),
      this.deps.storageStatus(node, storage),
      this.deps.storageImages(node, storage),
      this.deps.containers(node),
      Promise.all(
        node.volumes.map(async (v): Promise<VolumeSample> => {
          const [s, imgs] = await Promise.all([this.deps.storageStatus(node, v.storage), this.deps.storageImages(node, v.storage)]);
          return {
            id: v.id,
            storage: v.storage,
            sizeBytes: s.total || v.sizeGB * GB,
            usedBytes: s.used,
            allocatedBytes: imgs.reduce((sum, i) => sum + i.size, 0),
          };
        })
      ),
    ]);

    const allocatedDisk = images.reduce((sum, i) => sum + i.size, 0);
    const pct = (used: number, total: number) => (total > 0 ? round1((used / total) * 100) : 0);
    const sample: ServerSample = {
      nodeId: node.id,
      nodeName: node.name,
      hetznerServerId: node.hetznerServerId,
      physicalRam: status.memory.total,
      physicalRamUsed: status.memory.used,
      physicalRamPct: pct(status.memory.used, status.memory.total),
      physicalDisk: disk.total,
      physicalDiskUsed: disk.used,
      physicalDiskPct: pct(disk.used, disk.total),
      allocatedDisk,
      freePoolBytes: freePoolBytes(disk.total, allocatedDisk, this.config.diskPoolReserveGB),
      physicalCpu: status.cpus,
      physicalCpuPct: round1(status.cpu * 100),
      totalContainers: containers.length,
      activeContainers: containers.filter((c) => c.status === "running").length,
      allocatedRam: containers.reduce((sum, c) => sum + c.maxmem, 0),
      volumes,
      volumeTotalSpace: volumes.reduce((sum, v) => sum + v.sizeBytes, 0),
      volumeUsedSpace: volumes.reduce((sum, v) => sum + v.allocatedBytes, 0),
      status: "healthy",
      at,
    };

    const prev = this.states.get(node.id) ?? INITIAL_SERVER_STATE;
    const { events, resets, state, health } = evaluateServer(sample, prev, this.config, at);
    sample.status = health;

    const subject = subjectForNode(node.name);
    for (const type of resets) this.bus.reset(subject, type);
    for (const event of events) if (this.bus.publish(event)) this.counters.eventsPublished++;
    this.states.set(node.id, state);
    this.latest.set(node.id, sample);

    await this.deps
      .saveNode({
        nodeId: node.id,
        usedRamMB: Math.round(sample.physicalRamUsed / MB),
        usedDiskGB: Math.round(sample.physicalDiskUsed / GB),
        usedCpuPct: sample.physicalCpuPct,
        allocatedRamMB: Math.round(sample.allocatedRam / MB),
        allocatedDiskGB: Math.round(sample.allocatedDisk / GB),
        containerCount: sample.totalContainers,
        health,
        volumes: volumes.map((v) => ({ id: v.id, usedGB: Math.round(v.allocatedBytes / GB) })),
        at,
      })
      .catch((err) => this.log.error(`saving node ${node.name} failed:`, err));

    return sample;
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;
