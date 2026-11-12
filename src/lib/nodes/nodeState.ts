// Retiring a node (out of service, row and history kept), opening one for orders, and its
// shared-IPv4 flag (Stage C). Used by scripts/node/node-state.ts. A dry run unless --apply,
// and every refusal is worked out before anything changes.
import { isRetired, RETIRED_STATUS } from "@/lib/provisioning/nodeTarget";

export type NodeRow = {
  id: string;
  name: string;
  status: string;
  acceptNewClients: boolean;
  hetznerServerId: string;
  ipv6Subnet: string | null;
  hasOwnToken: boolean;
  /** The gateway (Stage B): its address and container, null when it has none. */
  gatewayIpv4?: string | null;
  gatewayVmId?: number | null;
  sharedIpv4?: boolean;
};

export type NodeStateChange = { status?: string; acceptNewClients?: boolean; sharedIpv4?: boolean };

export type NodeStateDeps = {
  findNode(name: string): Promise<NodeRow | null>;
  /** Services on the node that aren't DELETED or CANCELLED. */
  liveServices(nodeId: string): Promise<{ id: string; status: string }[]>;
  /** Volumes on the node that aren't DELETED. */
  liveVolumes(nodeId: string): Promise<{ id: string; status: string }[]>;
  /** Migrations from or to the node that are SCHEDULED or IN_PROGRESS. */
  openMigrations(name: string): Promise<number>;
  /** Engine approvals for "node:<name>" that are PENDING or APPROVED. */
  openApprovals(name: string): Promise<number>;
  /** Shared-mode services on the node that aren't DELETED. */
  sharedServices?(nodeId: string): Promise<number>;
  /** The change and its EngineLog row, together or not at all. */
  apply(node: NodeRow, change: NodeStateChange, log: { action: string; approvedBy: string }): Promise<void>;
};

export type NodeStateAction = "retire" | "open" | "shared-on" | "shared-off";
export type NodeStatePlan = { ok: boolean; problems: string[]; lines: string[]; node: NodeRow | null; change: NodeStateChange | null };

export async function planNodeState(deps: NodeStateDeps, name: string, action: NodeStateAction): Promise<NodeStatePlan> {
  const node = await deps.findNode(name);
  if (!node) return { ok: false, problems: [`no ProxmoxNode named ${name}`], lines: [], node: null, change: null };
  const now = `${node.name}: ${node.status}, ${node.acceptNewClients ? "open" : "closed"} for new clients (Hetzner server ${node.hetznerServerId})`;
  const problems: string[] = [];
  const lines = [now];

  if (action === "retire") {
    if (isRetired(node)) return { ok: true, problems, lines: [...lines, "already retired: nothing to change"], node, change: null };
    const [services, volumes, migrations, approvals] = await Promise.all([deps.liveServices(node.id), deps.liveVolumes(node.id), deps.openMigrations(node.name), deps.openApprovals(node.name)]);
    if (services.length) problems.push(`it still has ${services.length} service(s): ${services.map((s) => `${s.id} ${s.status}`).join(", ")}`);
    if (volumes.length) problems.push(`it still has ${volumes.length} volume(s): ${volumes.map((v) => `${v.id} ${v.status}`).join(", ")}`);
    if (migrations) problems.push(`${migrations} migration(s) from or to it are scheduled or running`);
    if (approvals) problems.push(`${approvals} engine approval(s) for it are pending or approved`);
    const change = { status: RETIRED_STATUS, acceptNewClients: false };
    lines.push(
      `set status ${RETIRED_STATUS} and close it for new clients: no placement, Buy button, monitor, engine action or container guess uses it again`,
      "the row and its history stay; the Hetzner server is deleted by hand afterwards"
    );
    return { ok: problems.length === 0, problems, lines, node, change };
  }

  if (action === "shared-on" || action === "shared-off") {
    const on = action === "shared-on";
    lines[0] += `, shared IPv4 ${node.sharedIpv4 ? "on" : "off"}`;
    if (on) {
      if (isRetired(node)) problems.push(`it's retired (${node.status})`);
      if (!node.gatewayIpv4 || node.gatewayVmId === null || node.gatewayVmId === undefined) problems.push("it has no gateway (a node gets one from install-node.ts): shared services couldn't be reached over IPv4");
    }
    if (Boolean(node.sharedIpv4) === on && !problems.length) return { ok: true, problems, lines: [...lines, `shared IPv4 is already ${on ? "on" : "off"}: nothing to change`], node, change: null };
    if (on) {
      lines.push(
        "turn shared IPv4 on: shared-mode orders may be placed here (still only when it's open, or by a pinned test order)",
        "every customer order stays DEDICATED until Stage G, so this alone changes no customer's server"
      );
    } else {
      const left = (await deps.sharedServices?.(node.id)) ?? 0;
      lines.push("turn shared IPv4 off: no new shared-mode service is placed here");
      if (left) lines.push(`its ${left} shared service(s) keep running and keep their routes`);
    }
    return { ok: problems.length === 0, problems, lines, node, change: { sharedIpv4: on } };
  }

  if (isRetired(node)) problems.push(`it's retired (${node.status}): a retired node isn't reopened, since its server may be gone`);
  if (!node.hasOwnToken) problems.push("it has no API token of its own: nothing could reach it (nodes get one from install-node.ts)");
  if (!node.ipv6Subnet) problems.push("it has no ipv6Subnet: containers couldn't get addresses");
  const status = node.status === "PROVISIONING" ? "READY" : node.status;
  if (!problems.length && node.acceptNewClients && status === node.status) return { ok: true, problems, lines: [...lines, "already open: nothing to change"], node, change: null };
  lines.push(`set status ${status} and open it for new clients: plans it can hold become buyable`);
  return { ok: problems.length === 0, problems, lines, node, change: { status, acceptNewClients: true } };
}

export async function applyNodeState(deps: NodeStateDeps, plan: NodeStatePlan, action: NodeStateAction, approvedBy: string): Promise<string> {
  if (!plan.ok || !plan.node) throw new Error(`refused: ${plan.problems.join("; ")}`);
  if (!approvedBy.trim()) throw new Error("--apply needs --approved-by <name>");
  if (!plan.change) return "nothing to change";
  const logAction = { retire: "NODE_RETIRED", open: "NODE_OPENED", "shared-on": "NODE_SHARED_IPV4_ON", "shared-off": "NODE_SHARED_IPV4_OFF" }[action];
  await deps.apply(plan.node, plan.change, { action: logAction, approvedBy });
  if (plan.change.sharedIpv4 !== undefined) return `${plan.node.name}: shared IPv4 ${plan.change.sharedIpv4 ? "on" : "off"}`;
  return `${plan.node.name}: ${plan.change.status}, ${plan.change.acceptNewClients ? "open" : "closed"} for new clients`;
}
