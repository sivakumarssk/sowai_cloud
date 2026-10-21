import type { Blocked, EngineLogWriter } from "./types";

export type VolumeNode = { id: string; name: string; ip: string; hetznerServerId: string; location: string };

/** Who approved a purchase/removal. Required — the VolumeManager never acts without it. */
export type Approval = { approvedBy: string; approvalId?: string };

export type VolumeManagerDeps = {
  createVolume(input: { name: string; sizeGB: number; location: string; labels: Record<string, string> }): Promise<{ id: number }>;
  attachVolume(volumeId: number, serverId: number): Promise<void>;
  /** Detaches (if attached) and deletes; already-deleted is fine. */
  deleteVolume(volumeId: number): Promise<void>;
  /** Mounts the attached volume on the node and registers it as Proxmox storage. */
  mountOnHost(node: VolumeNode, volumeId: number): Promise<{ storage: string; path: string }>;
  /** Unregisters the storage and unmounts (the node refuses if any disk is on it). */
  unmountOnHost(node: VolumeNode, volumeId: number): Promise<void>;
  /** Disk images currently on a storage. */
  disksOnStorage(node: VolumeNode, storage: string): Promise<string[]>;
  insertVolume(row: { hetznerVolumeId: string; nodeId: string; sizeGB: number; costPerMonth: number; status: string }): Promise<string>;
  updateVolume(id: string, data: { status?: string; proxmoxStorage?: string | null; mountPath?: string }): Promise<void>;
  spentThisMonthPaise(): Promise<number>;
  log: EngineLogWriter;
};

export type VolumeConfig = { volumeCostPerGbPaise: number; defaultSizeGB: number; spendCapPaise: number };

export type VolumePlan = {
  ok: true;
  kind: "VOLUME_PURCHASE";
  node: VolumeNode;
  sizeGB: number;
  /** New monthly spend, paise. */
  monthlyCostPaise: number;
  spentThisMonthPaise: number;
  /** Would push this month's engine spend over the cap. */
  overCap: boolean;
  reason: string;
  summary: string;
};

export type StoredVolume = { id: string; hetznerVolumeId: string; proxmoxStorage: string | null; sizeGB: number; node: VolumeNode };

const MIN_GB = 10;
const MAX_GB = 10_240;
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

function requireApproval(approval: Approval | undefined, what: string): Approval {
  if (!approval || !approval.approvedBy?.trim()) throw new Error(`admin approval required to ${what}`);
  return approval;
}

/**
 * Buys, attaches and mounts Hetzner Volumes for a node — only with an admin's
 * approval. A purchase that fails part-way is rolled back so nobody pays for
 * a Volume the node can't use.
 */
export class VolumeManager {
  constructor(
    private readonly deps: VolumeManagerDeps,
    private readonly config: VolumeConfig
  ) {}

  async plan(node: VolumeNode, request: { sizeGB?: number; reason: string }): Promise<VolumePlan | Blocked> {
    const sizeGB = Math.round(request.sizeGB ?? this.config.defaultSizeGB);
    if (sizeGB < MIN_GB || sizeGB > MAX_GB) {
      return { ok: false, code: "BAD_SIZE", reason: `Volume size must be ${MIN_GB}–${MAX_GB} GB, got ${sizeGB}` };
    }
    const monthlyCostPaise = sizeGB * this.config.volumeCostPerGbPaise;
    const spent = await this.deps.spentThisMonthPaise();
    const overCap = spent + monthlyCostPaise > this.config.spendCapPaise;
    return {
      ok: true,
      kind: "VOLUME_PURCHASE",
      node,
      sizeGB,
      monthlyCostPaise,
      spentThisMonthPaise: spent,
      overCap,
      reason: request.reason,
      summary: `buy a ${sizeGB} GB Hetzner Volume for ${node.name} (${rupees(monthlyCostPaise)}/month)${
        overCap ? ` — takes this month's engine spend to ${rupees(spent + monthlyCostPaise)}, over the ${rupees(this.config.spendCapPaise)} cap` : ""
      }`,
    };
  }

  async execute(plan: VolumePlan, approval: Approval): Promise<{ id: string; hetznerVolumeId: number; storage: string }> {
    const { approvedBy, approvalId } = requireApproval(approval, `buy a Volume (${rupees(plan.monthlyCostPaise)}/month)`);
    const { node } = plan;
    let hetznerId: number | null = null;
    let dbId: string | null = null;
    let mounted = false;

    try {
      const volume = await this.deps.createVolume({
        name: `sowsi-${node.name}-${Date.now()}`,
        sizeGB: plan.sizeGB,
        location: node.location,
        labels: { "sowsi-node": node.name, "sowsi-approved-by": approvedBy.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 63) },
      });
      hetznerId = volume.id;
      // Record it immediately: from here on it costs money and must be tracked.
      dbId = await this.deps.insertVolume({
        hetznerVolumeId: String(volume.id),
        nodeId: node.id,
        sizeGB: plan.sizeGB,
        costPerMonth: plan.monthlyCostPaise,
        status: "ATTACHING",
      });
      await this.deps.attachVolume(volume.id, Number(node.hetznerServerId));
      const { storage, path } = await this.deps.mountOnHost(node, volume.id);
      mounted = true;
      await this.deps.updateVolume(dbId, { status: "ACTIVE", proxmoxStorage: storage, mountPath: path });

      await this.deps.log({
        action: "VOLUME_CREATED",
        fromNode: node.name,
        after: { hetznerVolumeId: volume.id, sizeGB: plan.sizeGB, storage, path, approvedBy, approvalId, reason: plan.reason },
        cost: plan.monthlyCostPaise,
        trigger: "MANUAL",
      });
      return { id: dbId, hetznerVolumeId: volume.id, storage };
    } catch (err) {
      const rollback: string[] = [];
      let deleted = hetznerId === null;
      if (mounted && hetznerId !== null) {
        await this.deps.unmountOnHost(node, hetznerId).catch((e) => rollback.push(`unmount: ${message(e)}`));
      }
      if (hetznerId !== null) {
        try {
          await this.deps.deleteVolume(hetznerId);
          deleted = true;
        } catch (e) {
          rollback.push(`delete Volume ${hetznerId}: ${message(e)}`);
        }
      }
      if (dbId) await this.deps.updateVolume(dbId, { status: deleted ? "DELETED" : "ERROR" }).catch(() => {});

      await this.deps.log({
        action: "VOLUME_CREATED",
        fromNode: node.name,
        after: { hetznerVolumeId: hetznerId, sizeGB: plan.sizeGB, rolledBack: deleted, rollbackErrors: rollback, approvedBy, approvalId },
        // Still billed if it couldn't be deleted.
        cost: deleted ? 0 : plan.monthlyCostPaise,
        trigger: "MANUAL",
        success: false,
        error: `${message(err)}${deleted ? " — rolled back, Volume deleted" : ` — rollback FAILED, Volume ${hetznerId} still exists and is billed`}`,
      });
      throw err;
    }
  }

  /** Unmounts, detaches and deletes a Volume. Refused while any disk is on it. */
  async remove(volume: StoredVolume, approval: Approval): Promise<void> {
    const { approvedBy, approvalId } = requireApproval(approval, "delete a Volume");
    const hetznerId = Number(volume.hetznerVolumeId);
    try {
      if (volume.proxmoxStorage) {
        const disks = await this.deps.disksOnStorage(volume.node, volume.proxmoxStorage);
        if (disks.length > 0) throw new Error(`Volume still holds ${disks.length} disk(s): ${disks.join(", ")}`);
        await this.deps.unmountOnHost(volume.node, hetznerId);
      }
      await this.deps.deleteVolume(hetznerId);
      await this.deps.updateVolume(volume.id, { status: "DELETED", proxmoxStorage: null });
      await this.deps.log({
        action: "VOLUME_DELETED",
        fromNode: volume.node.name,
        after: { hetznerVolumeId: hetznerId, sizeGB: volume.sizeGB, approvedBy, approvalId },
        trigger: "MANUAL",
      });
    } catch (err) {
      await this.deps.log({
        action: "VOLUME_DELETED",
        fromNode: volume.node.name,
        after: { hetznerVolumeId: hetznerId, approvedBy, approvalId },
        trigger: "MANUAL",
        success: false,
        error: message(err),
      });
      throw err;
    }
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
