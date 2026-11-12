// Sends a node's whole route table to its gateway (Stage C of the shared IPv4 gateway).
//
// The table is every shared-mode service on the node that's ACTIVE or SUSPENDED: its name under
// c.sowsicloud.com, its route key and its private address. A full table has no drift: a service
// that's gone from it is gone from the gateway on the next sync. It runs after every route change
// (a shared service becoming ACTIVE, or being cancelled) and every 5 minutes from
// scripts/node/gateway-sync.ts, so a missed update doesn't last.
//
// Versions only go up. Each sync takes its version and reads its table under the node row's lock,
// so a higher version always carries a table read later. sowsi-gateway refuses one older than the
// version it applied: that's a newer table already in place, not a failure.
import { gatewayTable, type GatewayRoute } from "./nodeScripts";
import { serviceFqdn } from "@/lib/provisioning/publicName";

/** What sowsi-gateway's dispatcher accepts on the command line: 1 to 15 digits. */
export const MAX_GATEWAY_VERSION = 999_999_999_999_999;

export type RoutableService = {
  id: string;
  status: string;
  ipv4Mode: string;
  privateIpv4: string | null;
  publicName: string | null;
  routeKey: string | null;
  proxmoxVmId: string | null;
};

/** Statuses whose container exists and keeps its route (a suspended one is stopped, but still there). */
export const ROUTED_STATUSES = ["ACTIVE", "SUSPENDED"] as const;

/** The routes for a node's services, sorted by name so an unchanged table reads the same. */
export function routesFor(services: RoutableService[]): { routes: GatewayRoute[]; skipped: string[] } {
  const routes: GatewayRoute[] = [];
  const skipped: string[] = [];
  for (const s of services) {
    if (s.ipv4Mode !== "SHARED" || !(ROUTED_STATUSES as readonly string[]).includes(s.status)) continue;
    if (!s.privateIpv4 || !s.publicName || !s.routeKey || !s.proxmoxVmId) {
      skipped.push(`${s.id} (${s.status}) has no ${[!s.privateIpv4 && "private IPv4", !s.publicName && "name", !s.routeKey && "route key", !s.proxmoxVmId && "container"].filter(Boolean).join(", ")}`);
      continue;
    }
    routes.push({ host: serviceFqdn(s.publicName), key: s.routeKey, ipv4: s.privateIpv4 });
  }
  routes.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  return { routes, skipped };
}

/** Higher than the clock, the applied version and the last one handed out. */
export function nextVersion(nowMs: number, applied: bigint | null, issued: bigint | null): number {
  const v = Math.max(Math.floor(nowMs), applied === null ? 0 : Number(applied) + 1, issued === null ? 0 : Number(issued) + 1);
  if (!Number.isSafeInteger(v) || v < 0 || v > MAX_GATEWAY_VERSION) throw new Error(`gateway table version ${v} is out of range`);
  return v;
}

export type GatewayNode = { id: string; name: string; ip: string; gatewayIpv4: string };

export type Issued = { node: GatewayNode; version: number; services: RoutableService[] };

export type GatewaySyncDeps = {
  /**
   * Under the node row's lock: records the version as handed out and reads the node's services.
   * Null when the node has no gateway.
   */
  issue(nodeId: string, nowMs: number): Promise<Issued | null>;
  /** `gateway-sync <version>` over the restricted key, the table on stdin. Throws when refused. */
  send(node: GatewayNode, version: number, table: string): Promise<string>;
  /** Raises the node's applied version to at least this. */
  applied(nodeId: string, version: number): Promise<void>;
  now(): number;
};

export type GatewaySyncResult =
  | { node: string; status: "applied"; version: number; routes: number; skipped: string[]; output: string }
  /** A newer table was applied first: nothing to do. */
  | { node: string; status: "superseded"; version: number; applied: number; routes: number; skipped: string[] }
  | { node: string; status: "no-gateway" }
  | { node: string; status: "failed"; version?: number; error: string };

const OLDER = /refused: version (\d{1,15}) is older than the applied version (\d{1,15})/;

/** One sync of one node. Never throws: a failure comes back as status "failed". */
export async function syncGateway(deps: GatewaySyncDeps, nodeId: string): Promise<GatewaySyncResult> {
  let issued: Issued | null;
  try {
    issued = await deps.issue(nodeId, deps.now());
  } catch (err) {
    return { node: nodeId, status: "failed", error: message(err) };
  }
  if (!issued) return { node: nodeId, status: "no-gateway" };
  const { node, version } = issued;
  let table: string;
  let routes: GatewayRoute[];
  let skipped: string[];
  try {
    ({ routes, skipped } = routesFor(issued.services));
    table = gatewayTable(routes);
  } catch (err) {
    return { node: node.name, status: "failed", version, error: `the table for ${node.name} can't be built: ${message(err)}` };
  }
  try {
    const output = await deps.send(node, version, table);
    await deps.applied(node.id, version);
    return { node: node.name, status: "applied", version, routes: routes.length, skipped, output };
  } catch (err) {
    const older = OLDER.exec(message(err));
    if (older && Number(older[1]) === version) {
      const applied = Number(older[2]);
      await deps.applied(node.id, applied).catch(() => undefined);
      return { node: node.name, status: "superseded", version, applied, routes: routes.length, skipped };
    }
    return { node: node.name, status: "failed", version, error: message(err) };
  }
}

/** One line for logs and alerts. */
export function describeSync(r: GatewaySyncResult): string {
  switch (r.status) {
    case "applied": return `${r.node}: gateway table version ${r.version} applied (${r.routes} route${r.routes === 1 ? "" : "s"})${r.skipped.length ? `; left out: ${r.skipped.join("; ")}` : ""}`;
    case "superseded": return `${r.node}: version ${r.version} not needed, the gateway already has the newer ${r.applied}`;
    case "no-gateway": return `${r.node}: no gateway`;
    case "failed": return `${r.node}: gateway sync${r.version ? ` of version ${r.version}` : ""} FAILED: ${r.error}`;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
