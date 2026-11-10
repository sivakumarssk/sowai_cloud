// Retiring a node (out of service, row and history kept) and opening one for orders.
// Used by scripts/node/node-state.ts. A dry run unless --apply, and every refusal is
// worked out before anything changes.
import { isRetired, RETIRED_STATUS } from "@/lib/provisioning/nodeTarget";

export type NodeRow = {
  id: string;
  name: string;
  status: string;
  acceptNewClients: boolean;
  hetznerServerId: string;
  ipv6Subnet: string | null;
  hasOwnToken: boolean;
};

export type NodeStateChange = { status: string; acceptNewClients: boolean };

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
  /** The change and its EngineLog row, together or not at all. */
  apply(node: NodeRow, change: NodeStateChange, log: { action: string; approvedBy: string }): Promise<void>;
};

export type NodeStateAction = "retire" | "open";
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
  await deps.apply(plan.node, plan.change, { action: action === "retire" ? "NODE_RETIRED" : "NODE_OPENED", approvedBy });
  return `${plan.node.name}: ${plan.change.status}, ${plan.change.acceptNewClients ? "open" : "closed"} for new clients`;
}
