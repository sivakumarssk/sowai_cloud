// Simulated Proxmox + database for engine tests and the local demo.
// Containers are described by usage curves over poll ticks.

import type {
  ContainerMonitorDeps,
  ContainerSample,
  ManagedContainer,
  MonitoredNode,
  RawContainer,
} from "../monitors/ContainerMonitor";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

export type SimContainer = {
  vmid: number;
  name: string;
  /** Null = not linked to an active service (unmanaged). */
  serviceId: string | null;
  ramMB: number;
  diskGB: number;
  cores: number;
  /** Usage percentages for a tick (0-based). */
  ramPct: (tick: number) => number;
  diskPct: (tick: number) => number;
  cpuPct: (tick: number) => number;
  running?: (tick: number) => boolean;
};

export type SimNode = MonitoredNode & { containers: SimContainer[]; down?: (tick: number) => boolean };

export class SimulatedCluster {
  tick = 0;
  readonly saved: ContainerSample[] = [];

  constructor(readonly nodes: SimNode[]) {}

  advance(): void {
    this.tick++;
  }

  deps(): ContainerMonitorDeps {
    return {
      listNodes: async () => this.nodes.map(({ id, name, ip }) => ({ id, name, ip })),
      listContainers: async (node) => {
        const sim = this.find(node);
        if (sim.down?.(this.tick)) throw new Error(`connect ETIMEDOUT ${node.ip}:8006`);
        return sim.containers.map((c) => this.raw(c));
      },
      managedContainers: async (node): Promise<ManagedContainer[]> =>
        this.find(node)
          .containers.filter((c) => c.serviceId)
          .map((c) => ({
            vmid: c.vmid,
            serviceId: c.serviceId!,
            clientId: `user_${c.vmid}`,
            planRamMB: c.ramMB,
            planDiskGB: c.diskGB,
            planVcpu: c.cores,
          })),
      saveSamples: async (samples) => void this.saved.push(...samples),
    };
  }

  private find(node: MonitoredNode): SimNode {
    const sim = this.nodes.find((n) => n.id === node.id);
    if (!sim) throw new Error(`unknown node ${node.id}`);
    return sim;
  }

  private raw(c: SimContainer): RawContainer {
    const running = c.running?.(this.tick) ?? true;
    const clamp = (p: number) => Math.max(0, Math.min(100, p));
    return {
      vmid: c.vmid,
      name: c.name,
      status: running ? "running" : "stopped",
      mem: running ? (clamp(c.ramPct(this.tick)) / 100) * c.ramMB * MB : 0,
      maxmem: c.ramMB * MB,
      disk: (clamp(c.diskPct(this.tick)) / 100) * c.diskGB * GB,
      maxdisk: c.diskGB * GB,
      cpu: running ? clamp(c.cpuPct(this.tick)) / 100 : 0,
      cpus: c.cores,
      netin: this.tick * 1_000_000,
      netout: this.tick * 250_000,
    };
  }
}

/** Helpers for usage curves. */
export const flat = (pct: number) => () => pct;
export const steps = (...values: number[]) => (tick: number) => values[Math.min(tick, values.length - 1)];
