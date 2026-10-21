import type { EngineConfig } from "../config";
import { DATA_MOUNT_PATH, describePending, type ContainerDisks } from "./lxcConfig";
import type { Blocked, ContainerTarget, EngineLogEntry, EngineLogWriter } from "./types";

const GB = 1024 ** 3;

export type VolumeSpace = { id: string; storage: string; sizeGB: number; allocatedGB: number };

export type DiskExpanderDeps = {
  /** Root disk, /data mount and next free mount key as the container runs now, plus changes queued for its next restart. */
  readDisks(target: ContainerTarget): Promise<ContainerDisks>;
  /** Container storage of the node (the free pool): size and space promised to containers, bytes. */
  poolStatus(node: ContainerTarget["node"]): Promise<{ totalBytes: number; allocatedBytes: number }>;
  /** Attached Hetzner Volumes usable for container disks. */
  volumes(node: ContainerTarget["node"]): Promise<VolumeSpace[]>;
  /** Whether the client agreed to pay for disk beyond the plan. */
  overageOptIn(target: ContainerTarget): Promise<boolean>;
  /** Adds a new mount point (mounted live, no restart). */
  createMount(target: ContainerTarget, key: string, storage: string, sizeGB: number, path: string): Promise<void>;
  /** Grows rootfs or mpN online. size is absolute ("40G") or relative ("+10G"). */
  growDisk(target: ContainerTarget, key: string, size: string): Promise<void>;
  /** Remember the new sizes on the Service / Volume (managed containers only for Service). */
  recordRoot(target: ContainerTarget, rootGB: number): Promise<void>;
  recordData(target: ContainerTarget, data: { sizeGB: number; storage: string; volumeId: string | null; addedGB: number }): Promise<void>;
  log: EngineLogWriter;
};

export type DiskOperation = "RESIZE_ROOT" | "CREATE_DATA" | "RESIZE_DATA";
export type DiskSource = "FREE_POOL" | "VOLUME";

export type DiskPlan = {
  ok: true;
  kind: "DISK_EXPAND";
  target: ContainerTarget;
  operation: DiskOperation;
  source: DiskSource;
  /** Disk key affected: "rootfs" or "mpN". */
  diskKey: string;
  storage: string;
  volumeId: string | null;
  addGB: number;
  /** Sizes before/after: root disk and /data. */
  before: { rootGB: number; dataGB: number };
  after: { rootGB: number; dataGB: number };
  /** New monthly spend this commits (counted against the spend cap). Using existing pool/Volume space = 0. */
  monthlyCostPaise: number;
  /** Share of an existing Volume's cost now used by this client (tracking only). */
  attributedCostPaise: number;
  reason: string;
  summary: string;
};

export type DiskRequest = {
  /**
   * GROW_TO_PLAN: bring the root disk up to the plan size (e.g. after a plan upgrade).
   * EXTRA_SPACE:  add space beyond the plan at /data — only for clients who opted in to overage.
   */
  purpose: "GROW_TO_PLAN" | "EXTRA_SPACE";
  addGB?: number;
  reason: string;
};

/** Pool space needed for an expansion, per spec: 1.2 × the request, on top of the reserve. */
const POOL_SAFETY = 1.2;

/**
 * Adds disk space without ever growing the root disk past the plan:
 * extra space is a /data mount, from the free pool first, then an attached
 * Volume. When neither has room it reports that a Volume is needed (a
 * separate, approval-gated purchase).
 */
export class DiskExpander {
  constructor(
    private readonly deps: DiskExpanderDeps,
    private readonly config: Pick<EngineConfig, "containerStorage" | "diskPoolReserveGB" | "diskExpandChunkGB" | "volumeCostPerGbPaise">
  ) {}

  /** Free-pool space that can be handed out, GB (after the reserve). */
  async poolFreeGB(node: ContainerTarget["node"]): Promise<number> {
    const { totalBytes, allocatedBytes } = await this.deps.poolStatus(node);
    return Math.max(0, (totalBytes - allocatedBytes) / GB - this.config.diskPoolReserveGB);
  }

  async plan(target: ContainerTarget, request: DiskRequest): Promise<DiskPlan | Blocked> {
    const disks = await this.deps.readDisks(target);
    if (disks.pending.length > 0) return pendingRestart(disks);
    const before = { rootGB: disks.root.sizeGB, dataGB: disks.data?.sizeGB ?? 0 };
    const poolFree = await this.poolFreeGB(target.node);
    const pool = this.config.containerStorage;

    const make = (p: Omit<DiskPlan, "ok" | "kind" | "target" | "before" | "after" | "reason" | "summary" | "monthlyCostPaise" | "attributedCostPaise">): DiskPlan => {
      const after =
        p.operation === "RESIZE_ROOT" ? { rootGB: before.rootGB + p.addGB, dataGB: before.dataGB } : { rootGB: before.rootGB, dataGB: before.dataGB + p.addGB };
      const where = p.source === "FREE_POOL" ? `free pool (${pool})` : `Volume ${p.storage}`;
      const what =
        p.operation === "RESIZE_ROOT"
          ? `grow root disk ${before.rootGB} → ${after.rootGB} GB (plan size)`
          : p.operation === "CREATE_DATA"
            ? `add ${p.addGB} GB at ${DATA_MOUNT_PATH} (${p.diskKey})`
            : `grow ${DATA_MOUNT_PATH} ${before.dataGB} → ${after.dataGB} GB`;
      return {
        ok: true,
        kind: "DISK_EXPAND",
        target,
        before,
        after,
        reason: request.reason,
        monthlyCostPaise: 0,
        attributedCostPaise: p.source === "VOLUME" ? p.addGB * this.config.volumeCostPerGbPaise : 0,
        summary: `container ${target.vmid} on ${target.node.name}: ${what} from ${where}`,
        ...p,
      };
    };

    // ── Root disk up to the plan ──
    if (request.purpose === "GROW_TO_PLAN") {
      const need = target.planDiskGB - before.rootGB;
      if (need <= 0) return { ok: false, code: "ROOT_AT_PLAN", reason: `root disk is already ${before.rootGB} GB (plan ${target.planDiskGB} GB)` };
      if (disks.root.storage !== pool) {
        return { ok: false, code: "ROOT_NOT_ON_POOL", reason: `root disk is on ${disks.root.storage}, not the free pool (${pool})` };
      }
      if (poolFree < need) {
        return {
          ok: false,
          code: "POOL_FULL",
          reason: `free pool has ${round1(poolFree)} GB, needs ${need} GB`,
          next: { kind: "NOTIFY_CLIENT", detail: "server is full — migrate the client to a node with room" },
        };
      }
      return make({ operation: "RESIZE_ROOT", source: "FREE_POOL", diskKey: "rootfs", storage: pool, volumeId: null, addGB: need });
    }

    // ── Extra space at /data (beyond the plan) ──
    if (!(await this.deps.overageOptIn(target))) {
      return {
        ok: false,
        code: "OVERAGE_NOT_ENABLED",
        reason: "client hasn't enabled paid overage — disk stays at the plan limit",
        next: { kind: "NOTIFY_CLIENT", detail: "storage is full: upgrade the plan or enable overage billing" },
      };
    }
    const addGB = Math.max(1, Math.round(request.addGB ?? this.config.diskExpandChunkGB));
    const poolFits = poolFree >= addGB * POOL_SAFETY;
    const volumes = await this.deps.volumes(target.node);
    const volumeWithRoom = (storage?: string) =>
      volumes.find((v) => (!storage || v.storage === storage) && v.sizeGB - v.allocatedGB >= addGB) ?? null;
    const needVolume: Blocked = {
      ok: false,
      code: "NEEDS_VOLUME",
      reason: `no room for ${addGB} GB: free pool has ${round1(poolFree)} GB${volumes.length ? ", attached Volumes are full" : ", no Volume attached"}`,
      next: { kind: "VOLUME_PURCHASE", detail: "attach a 100 GB Hetzner Volume", monthlyCostPaise: 100 * this.config.volumeCostPerGbPaise },
    };

    if (disks.data) {
      // A mount point can only grow on the storage it lives on.
      if (disks.data.storage === pool) {
        return poolFits
          ? make({ operation: "RESIZE_DATA", source: "FREE_POOL", diskKey: disks.data.key, storage: pool, volumeId: null, addGB })
          : needVolume;
      }
      const volume = volumeWithRoom(disks.data.storage);
      return volume
        ? make({ operation: "RESIZE_DATA", source: "VOLUME", diskKey: disks.data.key, storage: volume.storage, volumeId: volume.id, addGB })
        : { ...needVolume, reason: `${DATA_MOUNT_PATH} is on ${disks.data.storage}, which has no room for ${addGB} GB`, next: { kind: "VOLUME_PURCHASE", detail: `grow Volume ${disks.data.storage}` } };
    }

    if (!disks.freeMountKey) return { ok: false, code: "NO_MOUNT_SLOT", reason: "container has no free mount point slot" };
    if (poolFits) return make({ operation: "CREATE_DATA", source: "FREE_POOL", diskKey: disks.freeMountKey, storage: pool, volumeId: null, addGB });
    const volume = volumeWithRoom();
    if (volume) return make({ operation: "CREATE_DATA", source: "VOLUME", diskKey: disks.freeMountKey, storage: volume.storage, volumeId: volume.id, addGB });
    return needVolume;
  }

  /** Applies a plan: re-checks the disks are unchanged, changes them online, verifies, records, logs. */
  async execute(plan: DiskPlan, trigger: EngineLogEntry["trigger"]): Promise<DiskResult> {
    const { target } = plan;
    const entry = {
      action: `DISK_${plan.operation}`,
      serviceId: target.serviceId,
      vmid: target.vmid,
      fromNode: target.node.name,
      before: plan.before,
      cost: plan.attributedCostPaise,
      trigger,
    };
    try {
      const current = await this.deps.readDisks(target);
      if (current.pending.length > 0) throw new Error(`${pendingRestart(current).reason}; re-plan after the restart`);
      const now = { rootGB: current.root.sizeGB, dataGB: current.data?.sizeGB ?? 0 };
      if (now.rootGB !== plan.before.rootGB || now.dataGB !== plan.before.dataGB) {
        throw new Error(`disks changed since planning (${JSON.stringify(plan.before)} → ${JSON.stringify(now)}); re-plan`);
      }

      if (plan.operation === "RESIZE_ROOT") await this.deps.growDisk(target, "rootfs", `${plan.after.rootGB}G`);
      else if (plan.operation === "CREATE_DATA") await this.deps.createMount(target, plan.diskKey, plan.storage, plan.addGB, DATA_MOUNT_PATH);
      else await this.deps.growDisk(target, plan.diskKey, `+${plan.addGB}G`);

      const result = await this.deps.readDisks(target);
      // Proxmox can't always apply a disk change to a running container: it queues it for the
      // next restart. That isn't a failure, and the engine never restarts a client's container.
      const queued = result.pending.filter((c) => c.key === plan.diskKey);
      if (queued.length > 0) {
        const unchanged = { rootGB: result.root.sizeGB, dataGB: result.data?.sizeGB ?? 0 };
        await this.deps.log({
          ...entry,
          action: `${entry.action}_QUEUED`,
          after: { ...unchanged, queuedUntilRestart: describePending(queued), source: plan.source, storage: plan.storage, reason: plan.reason },
        });
        return { ...unchanged, queuedUntilRestart: describePending(queued) };
      }
      const got = { rootGB: result.root.sizeGB, dataGB: result.data?.sizeGB ?? 0 };
      if (got.rootGB !== plan.after.rootGB || got.dataGB !== plan.after.dataGB) {
        throw new Error(`Proxmox reports ${JSON.stringify(got)} after expanding to ${JSON.stringify(plan.after)}`);
      }

      if (plan.operation === "RESIZE_ROOT") await this.deps.recordRoot(target, got.rootGB);
      else await this.deps.recordData(target, { sizeGB: got.dataGB, storage: plan.storage, volumeId: plan.volumeId, addedGB: plan.addGB });
      await this.deps.log({ ...entry, after: { ...got, source: plan.source, storage: plan.storage, reason: plan.reason } });
      return got;
    } catch (err) {
      await this.deps.log({
        ...entry,
        after: { ...plan.after, source: plan.source, storage: plan.storage, reason: plan.reason },
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Records a plan that was only logged (OBSERVE mode) or is waiting for approval. */
  async logPlanOnly(plan: DiskPlan, trigger: EngineLogEntry["trigger"], why: string): Promise<void> {
    await this.deps.log({
      action: `DISK_${plan.operation}_PLANNED`,
      serviceId: plan.target.serviceId,
      vmid: plan.target.vmid,
      fromNode: plan.target.node.name,
      before: plan.before,
      after: { ...plan.after, source: plan.source, storage: plan.storage, reason: plan.reason, notExecutedBecause: why },
      cost: plan.attributedCostPaise,
      trigger,
      dryRun: true,
    });
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Sizes after execute. `queuedUntilRestart`: Proxmox queued the change; it takes effect when the container next restarts. */
export type DiskResult = { rootGB: number; dataGB: number; queuedUntilRestart?: string };

function pendingRestart(disks: ContainerDisks): Blocked {
  return {
    ok: false,
    code: "PENDING_RESTART",
    reason: `disk changes are queued until the container restarts (${describePending(disks.pending)}) — the engine never restarts a client's container`,
  };
}
