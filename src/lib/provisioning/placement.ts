// Where a new container goes — and what happens when it fits nowhere.
//
// A node takes a new container when it's open to new clients and has room
// for the plan's RAM and disk. Among those, the one with the most free RAM
// wins (spreads load). If none fits, the paid order is never failed or
// refunded: it stays PROVISIONING (0%, waitingForNodeSince set), the admin is
// alerted, and the provisioning sweep starts it once a node has room.

export type Need = { ramMB: number; diskGB: number };

export type NodeLoad = {
  id: string;
  name: string;
  ip: string;
  hetznerServerId: string;
  location: string;
  ipv6Subnet: string | null;
  acceptNewClients: boolean;
  status: string;
  physicalRamMB: number;
  /** Size of the container storage (free pool), GB. */
  physicalDiskGB: number;
  maxContainers: number;
  /** What the ServerMonitor last saw on the node (includes test/unmanaged containers). Null when stale. */
  monitor: { allocatedRamMB: number; allocatedDiskGB: number; containerCount: number; hostUsedRamMB: number | null } | null;
  /** ACTIVE / SUSPENDED services on the node, from the database. */
  settled: Need & { count: number };
  /** Orders placed on the node but not finished (PROVISIONING / INSTALLING) — the monitor may not see them yet. */
  inFlight: Need & { count: number };
};

export type PlacementConfig = {
  /** Promised container RAM may reach physical RAM × this. 1 = no overcommit. */
  ramOvercommit: number;
  /** Promised container disk may reach the pool × this. 1 = no thin provisioning. */
  diskOvercommit: number;
  /** Free-pool space never handed out (same reserve the DiskExpander keeps). */
  diskPoolReserveGB: number;
  /** RAM always kept for Proxmox itself: the host keeps more only if it was measured using more. */
  hostRamReserveMB: number;
};

type HostReading = { monitor?: { hostUsedRamMB: number | null } | null };

/** RAM the host keeps: the larger of what the monitor measured and the reserve. */
export function hostRamMB(node: HostReading, config: PlacementConfig): number {
  return Math.max(node.monitor?.hostUsedRamMB ?? 0, config.hostRamReserveMB);
}

/** RAM containers may be promised. The host's share is real memory, so it's taken off before any overcommit. */
export function usableRamMB(node: Pick<NodeLoad, "physicalRamMB"> & HostReading, config: PlacementConfig): number {
  return Math.floor(Math.max(0, node.physicalRamMB - hostRamMB(node, config)) * config.ramOvercommit);
}

/** Disk containers may be promised. The reserve is real space, so it's taken off before any overcommit. */
export function usableDiskGB(node: Pick<NodeLoad, "physicalDiskGB">, config: PlacementConfig): number {
  return Math.floor(Math.max(0, node.physicalDiskGB - config.diskPoolReserveGB) * config.diskOvercommit);
}

/** Why a node takes no new containers at all, or null if it's open. */
export function closedReason(node: Pick<NodeLoad, "name" | "acceptNewClients" | "status">): string | null {
  if (!node.acceptNewClients) return `${node.name} is closed to new clients`;
  // READY/WARNING/CRITICAL are health (written by the ServerMonitor), not closure.
  if (node.status === "PROVISIONING" || node.status === "DECOMMISSIONING") return `${node.name} is ${node.status}`;
  return null;
}

export type Fit = { ok: true; freeRamMB: number; freeDiskGB: number } | { ok: false; reason: string };

/**
 * Room left on a node. Committed = the larger of what the monitor sees and
 * what the database has settled there, plus orders still being set up
 * (counted even if the monitor already sees them — erring on the safe side).
 */
export function nodeFit(node: NodeLoad, need: Need, config: PlacementConfig): Fit {
  const closed = closedReason(node);
  if (closed) return { ok: false, reason: closed };
  if (!node.ipv6Subnet) return { ok: false, reason: `${node.name} has no IPv6 subnet configured` };

  const ram = Math.max(node.monitor?.allocatedRamMB ?? 0, node.settled.ramMB) + node.inFlight.ramMB;
  const disk = Math.max(node.monitor?.allocatedDiskGB ?? 0, node.settled.diskGB) + node.inFlight.diskGB;
  const count = Math.max(node.monitor?.containerCount ?? 0, node.settled.count) + node.inFlight.count;

  const freeRamMB = usableRamMB(node, config) - ram;
  const freeDiskGB = usableDiskGB(node, config) - disk;
  if (count >= node.maxContainers) return { ok: false, reason: `${node.name} has ${count}/${node.maxContainers} containers` };
  if (freeRamMB < need.ramMB) return { ok: false, reason: `${node.name} has ${Math.max(0, freeRamMB)} MB RAM free, needs ${need.ramMB} MB` };
  if (freeDiskGB < need.diskGB) return { ok: false, reason: `${node.name} has ${Math.max(0, freeDiskGB)} GB disk free (after ${config.diskPoolReserveGB} GB reserve), needs ${need.diskGB} GB` };
  return { ok: true, freeRamMB, freeDiskGB };
}

/** The open node with room and the most free RAM; otherwise why each node was refused. */
export function chooseNode(nodes: NodeLoad[], need: Need, config: PlacementConfig): { node: NodeLoad; reasons: string[] } | { node: null; reasons: string[] } {
  const reasons: string[] = [];
  let best: { node: NodeLoad; freeRamMB: number; freeDiskGB: number } | null = null;
  for (const node of nodes) {
    const fit = nodeFit(node, need, config);
    if (!fit.ok) {
      reasons.push(fit.reason);
      continue;
    }
    const better = !best || fit.freeRamMB > best.freeRamMB || (fit.freeRamMB === best.freeRamMB && fit.freeDiskGB > best.freeDiskGB);
    if (better) best = { node, ...fit };
  }
  if (nodes.length === 0) reasons.push("no Proxmox nodes are registered");
  if (!best && nodes.length > 0 && !nodes.some((n) => fitsWhenEmpty(n, need, config))) {
    reasons.unshift(`no registered node is big enough for this plan even when empty (${need.ramMB} MB RAM, ${need.diskGB} GB disk) — it needs a larger server`);
  }
  return best ? { node: best.node, reasons } : { node: null, reasons };
}

/** Whether a node could hold this plan at all, even with nothing else on it. */
export function fitsWhenEmpty(node: Pick<NodeLoad, "physicalRamMB" | "physicalDiskGB"> & HostReading, need: Need, config: PlacementConfig): boolean {
  return usableRamMB(node, config) >= need.ramMB && usableDiskGB(node, config) >= need.diskGB;
}

/** How many more of this plan a node would take right now. */
export function fitCount(node: NodeLoad, need: Need, config: PlacementConfig): number {
  const trial = { ...node };
  let count = 0;
  while (nodeFit(trial, need, config).ok) {
    reserve(trial, need);
    count++;
  }
  return count;
}

/** Counts an order as in flight on a node (for several placements in one pass). */
export function reserve(node: NodeLoad, need: Need): void {
  node.inFlight = { ramMB: node.inFlight.ramMB + need.ramMB, diskGB: node.inFlight.diskGB + need.diskGB, count: node.inFlight.count + 1 };
}

// ── Placing one order ────────────────────────────────────────────────

export type PlaceableOrder = { status: string; provisioningPct: number; need: Need };

/** Runs inside a lock that serialises placements, so two orders can't both take the last slot. */
export type PlacementTx = {
  order(serviceId: string): Promise<PlaceableOrder | null>;
  nodes(): Promise<NodeLoad[]>;
  /** PROVISIONING 0% → 10% on that node (waiting flag cleared). False if someone else claimed it. */
  claim(serviceId: string, nodeId: string): Promise<boolean>;
  /** Sets waitingForNodeSince if not set yet. True when it was just set. */
  markWaiting(serviceId: string, step: string): Promise<boolean>;
};

export type OrderInfo = { serviceId: string; planName: string; customer: string; waitingSince: Date | null };

export type PlacementDeps = {
  locked<T>(fn: (tx: PlacementTx) => Promise<T>): Promise<T>;
  config: PlacementConfig;
  orderInfo(serviceId: string): Promise<OrderInfo>;
  alertAdmin(subject: string, detail: string): Promise<void>;
  /** In-app message to the customer. */
  notifyCustomer(serviceId: string, message: string): Promise<void>;
  log(entry: { action: string; serviceId: string; after: unknown }): Promise<void>;
};

export const WAITING_STEP = "Queued — waiting for server capacity. Your server will be set up automatically.";

export type PlacementResult =
  | { status: "PLACED"; node: NodeLoad }
  /** No node fits: parked, admin alerted once. Nothing bought, nothing refunded. */
  | { status: "WAIT"; reason: string }
  /** Not a fresh paid order (already claimed, cancelled, …): leave it alone. */
  | { status: "SKIP" };

/** Picks a node for a paid order and claims the order on it — or parks the order. */
export async function placeOrder(serviceId: string, deps: PlacementDeps): Promise<PlacementResult> {
  const result = await deps.locked(async (tx): Promise<PlacementResult & { newlyWaiting?: boolean }> => {
    const order = await tx.order(serviceId);
    if (!order || order.status !== "PROVISIONING" || order.provisioningPct !== 0) return { status: "SKIP" };
    const choice = chooseNode(await tx.nodes(), order.need, deps.config);
    if (choice.node) {
      return (await tx.claim(serviceId, choice.node.id)) ? { status: "PLACED", node: choice.node } : { status: "SKIP" };
    }
    const reason = choice.reasons.join("; ");
    return { status: "WAIT", reason, newlyWaiting: await tx.markWaiting(serviceId, WAITING_STEP) };
  });

  if (result.status === "WAIT" && result.newlyWaiting) {
    const o = await deps.orderInfo(serviceId);
    await deps.alertAdmin(
      `Paid order waiting for a server: ${o.planName}`,
      [
        `Service ${serviceId} (${o.planName}) for ${o.customer} is paid but no node can take it:`,
        `  ${result.reason}`,
        "It stays queued (PROVISIONING) — it is NOT failed or refunded.",
        "It starts automatically within 15 minutes of a node having room (reopen a node or add one).",
      ].join("\n")
    );
    await deps.notifyCustomer(serviceId, `Your ${o.planName} order is paid and queued. We're preparing server capacity and will set it up automatically — no action needed.`);
    await deps.log({ action: "PROVISION_WAITING_FOR_NODE", serviceId, after: { reason: result.reason } });
  }
  if (result.status === "WAIT") return { status: "WAIT", reason: result.reason };
  return result.status === "PLACED" ? { status: "PLACED", node: result.node } : { status: "SKIP" };
}

// ── The 15-minute sweep ──────────────────────────────────────────────

export type PendingOrder = OrderInfo & { need: Need };

export type SweepDeps = {
  /** PROVISIONING, 0% VPS orders: waiting for a node, or never started (e.g. lost in a restart). Oldest first. */
  pendingOrders(): Promise<PendingOrder[]>;
  /** Current node loads (no lock: provisioning re-checks under the lock). */
  nodes(): Promise<NodeLoad[]>;
  config: PlacementConfig;
  /** Starts provisioning (fire and forget). */
  start(serviceId: string): Promise<void>;
  alertAdmin(subject: string, detail: string): Promise<void>;
  lastReminderAt(): Promise<Date | null>;
  recordReminder(count: number): Promise<void>;
};

/** Reminder while paid orders keep waiting. */
export const REMINDER_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Starts every waiting order that now fits somewhere (oldest first, each one
 * counted against its node before the next is checked). Orders that never
 * started are always started, so provisioning parks and alerts them properly.
 * While orders keep waiting, re-alerts the admin every 6 hours.
 */
export async function resumeWaitingOrders(deps: SweepDeps, now = new Date()): Promise<{ started: number; waiting: number }> {
  const orders = await deps.pendingOrders();
  if (orders.length === 0) return { started: 0, waiting: 0 };

  const nodes = await deps.nodes();
  const stillWaiting: { order: PendingOrder; reason: string }[] = [];
  let started = 0;
  for (const order of orders) {
    const choice = chooseNode(nodes, order.need, deps.config);
    if (choice.node) reserve(choice.node, order.need);
    if (choice.node || !order.waitingSince) {
      await deps.start(order.serviceId);
      started++;
    } else {
      stillWaiting.push({ order, reason: choice.reasons.join("; ") });
    }
  }

  const last = await deps.lastReminderAt();
  if (stillWaiting.length > 0 && (!last || now.getTime() - last.getTime() >= REMINDER_EVERY_MS)) {
    const hours = (d: Date) => Math.max(0, Math.round((now.getTime() - d.getTime()) / 3_600_000));
    await deps.alertAdmin(
      `${stillWaiting.length} paid order${stillWaiting.length === 1 ? "" : "s"} still waiting for a server`,
      [
        "These customers have paid and are waiting for capacity:",
        ...stillWaiting.map(({ order: o, reason }) => `  ${o.serviceId}  ${o.planName}  ${o.customer}  waiting ${hours(o.waitingSince!)} h — ${reason}`),
      ].join("\n")
    );
    await deps.recordReminder(stillWaiting.length);
  }
  return { started, waiting: stillWaiting.length };
}
