// Whether a plan can be bought at all. A plan is only sold when it can be
// built for real: a VPS plan that fits on at least one registered node (even
// an empty one), never a plan with no automated provisioning.

import { fitsWhenEmpty, type Need, type PlacementConfig } from "./placement";

export type NodeCapacity = { name: string; status: string; physicalRamMB: number; physicalDiskGB: number; monitor?: { hostUsedRamMB: number | null } | null };

export type Availability = { orderable: true } | { orderable: false; reason: string };

/** Shown to customers instead of the Buy button. */
export const UNAVAILABLE_LABEL = "Currently unavailable";

export function planAvailability(plan: { category: string; ramGB: number | null; storageGB: number | null }, nodes: NodeCapacity[], config: PlacementConfig): Availability {
  if (plan.category !== "VPS") return { orderable: false, reason: `no automated provisioning for ${plan.category} plans yet` };
  const need: Need = { ramMB: (plan.ramGB ?? 0) * 1024, diskGB: plan.storageGB ?? 0 };
  // A node still PROVISIONING (installed, not opened by hand) takes no orders, so it doesn't make plans buyable.
  const usable = nodes.filter((n) => n.status !== "DECOMMISSIONING" && n.status !== "PROVISIONING");
  if (usable.length === 0) return { orderable: false, reason: "no Proxmox node is registered" };
  if (!usable.some((n) => fitsWhenEmpty(n, need, config))) {
    const largest = usable.reduce((a, b) => (b.physicalRamMB > a.physicalRamMB ? b : a));
    return {
      orderable: false,
      reason: `no registered node can hold ${need.ramMB} MB RAM / ${need.diskGB} GB disk even when empty (largest: ${largest.name}, ${largest.physicalRamMB} MB, ${largest.physicalDiskGB - config.diskPoolReserveGB} GB usable)`,
    };
  }
  return { orderable: true };
}
