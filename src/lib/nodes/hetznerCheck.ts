// What scripts/node/hetzner-check.ts does: read every Hetzner endpoint we depend
// on and report whether it answers and whether the fields we read are there.
// Takes a GET function, so nothing here can create, change or delete anything.
import { serverTypeOffer, toServer, type ApiServerType } from "@/lib/hetzner";
import { isRetired } from "@/lib/provisioning/nodeTarget";
import { describeFloatingIpv4, describeIncludedTraffic, describeTrafficPrice, HETZNER_INVOICE } from "./hetznerInvoice";

const INSTALL_LABEL = "sowsi-node-install";

/** The only thing this module can do to Hetzner. */
export type HetznerGet = (path: string, params?: Record<string, string | number>) => Promise<unknown>;

/** The only SSH key that should stay in the project. */
export const EXPECTED_SSH_KEY = "sowsi-hosting";

/** Created by the installer, by hand with our naming (the first node, the management server), or a registered node. */
export function isOurServer(s: { id: number; name: string; labels: Record<string, string> }, ownServerIds: string[]): boolean {
  return s.labels[INSTALL_LABEL] === "1" || ownServerIds.includes(String(s.id)) || /^sowsi-(mgmt|proxmox)-\d+$/.test(s.name);
}

export type CheckResult = { endpoint: string; ok: boolean; detail: string; fields: string[]; missing: string[]; notes: string[] };

/** "a.b[].c" present on the first row? A null value counts as present; undefined doesn't. */
export function hasField(value: unknown, field: string): boolean {
  let current: unknown = value;
  for (const part of field.split(".")) {
    const isList = part.endsWith("[]");
    const key = isList ? part.slice(0, -2) : part;
    if (current === null || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[key];
    if (current === undefined) return false;
    if (isList) {
      if (!Array.isArray(current)) return false;
      if (current.length === 0) return true;
      current = current[0];
    }
  }
  return true;
}

const errorOf = (err: unknown) => {
  const e = err as { response?: { status?: number; data?: { error?: { code?: string; message?: string } } }; message?: string };
  const body = e.response?.data?.error;
  return `${e.response?.status ?? "no response"}${body ? ` ${body.code}: ${body.message}` : ` ${e.message ?? String(err)}`}`;
};

async function check(
  get: HetznerGet,
  endpoint: string,
  path: string,
  params: Record<string, string | number> | undefined,
  key: string,
  fields: string[],
  inspect?: (rows: Record<string, unknown>[], data: Record<string, unknown>) => string[]
): Promise<{ result: CheckResult; rows: Record<string, unknown>[] }> {
  try {
    const data = (await get(path, params)) as Record<string, unknown>;
    const raw = data[key];
    const rows = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) as Record<string, unknown>[];
    if (raw === undefined) return { rows, result: { endpoint, ok: false, detail: `answer has no "${key}"`, fields, missing: [key], notes: [] } };
    const missing = rows.length ? fields.filter((f) => !hasField(rows[0], f)) : [];
    const notes = inspect ? inspect(rows, data) : [];
    return { rows, result: { endpoint, ok: missing.length === 0, detail: `${rows.length} row(s)${rows.length ? "" : " — fields not checked"}`, fields, missing, notes } };
  } catch (err) {
    return { rows: [], result: { endpoint, ok: false, detail: errorOf(err), fields, missing: [], notes: [] } };
  }
}

/** Every Hetzner read we depend on. Plain GETs, in the order the installer uses them. */
/** A ProxmoxNode row as hetzner-check sees it; `problem` when the database couldn't be read. */
export type RegisteredNodes = { name: string; hetznerServerId: string; status: string }[] | { problem: string };

export type CheckOptions = {
  serverType: string;
  location: string;
  ownServerIds?: string[];
  /** The registered nodes, so a Floating IP on anything else is flagged. */
  nodes?: RegisteredNodes;
  /** Servers that must be gone, with their Primary IPs, Floating IPs and Volumes (--expect-gone). */
  expectGone?: string[];
};

export async function runHetznerChecks(get: HetznerGet, opts: CheckOptions): Promise<CheckResult[]> {
  const { serverType, location, nodes, expectGone = [] } = opts;
  const ownServerIds = [...(opts.ownServerIds ?? []), ...(nodes && Array.isArray(nodes) ? nodes.map((n) => n.hetznerServerId) : [])];
  const results: CheckResult[] = [];
  const add = async (...args: Parameters<typeof check> extends [HetznerGet, ...infer R] ? R : never) => {
    const r = await check(get, ...args);
    results.push(r.result);
    return r.rows;
  };

  await add(`GET /server_types?name=${serverType}`, "/server_types", { name: serverType }, "server_types", ["id", "name", "architecture", "cores", "memory", "disk", "prices[].location", "prices[].price_hourly.gross", "prices[].price_monthly.gross", "locations[].name", "locations[].available", "locations[].deprecation"], (rows) => {
    if (rows.length === 0) return [`${serverType} is not a Hetzner server type`];
    const offer = serverTypeOffer(rows[0] as unknown as ApiServerType, location);
    const here = (rows[0].prices as { location?: string; included_traffic?: unknown; price_per_tb_traffic?: { gross?: unknown } }[] | undefined)?.find((p) => p.location === location);
    return [
      offer.buyable ? `${serverType} is buyable in ${location}: $${offer.price!.monthly}/month, $${offer.price!.hourly}/hour (gross)` : `NOT buyable: ${offer.reason}`,
      `architecture ${String(rows[0].architecture)}${rows[0].architecture === "x86" ? "" : " — Proxmox needs x86"}`,
      describeIncludedTraffic(here?.included_traffic),
      describeTrafficPrice(here?.price_per_tb_traffic?.gross),
    ];
  });

  await add("GET /locations", "/locations", undefined, "locations", ["name", "network_zone"], (rows) => {
    const here = rows.find((l) => l.name === location);
    return [here ? `${location} is in ${String(here.network_zone)}` : `${location} is not in the list`];
  });

  await add("GET /pricing", "/pricing", undefined, "pricing", ["currency", "primary_ips[].type", "primary_ips[].prices[].location", "primary_ips[].prices[].price_hourly.gross", "primary_ips[].prices[].price_monthly.gross", "floating_ips[].type", "floating_ips[].prices[].location", "floating_ips[].prices[].price_monthly.gross"], (rows) => {
    const p = rows[0] as { currency?: string; primary_ips?: { type: string; prices: { location: string; price_monthly: { gross: string } }[] }[]; floating_ips?: { type: string; prices: { location: string; price_monthly: { gross: string } }[] }[] };
    const monthly = (list: typeof p.primary_ips) => list?.find((t) => t.type === "ipv4")?.prices.find((x) => x.location === location)?.price_monthly.gross;
    return [`currency ${String(p.currency)}${p.currency === "USD" ? "" : " — costs here are worked out from USD"}`, `Primary IPv4 in ${location}: $${monthly(p.primary_ips) ?? "?"}/month`, `Floating IPv4 in ${location}: ${describeFloatingIpv4(monthly(p.floating_ips) === undefined ? null : Number(monthly(p.floating_ips)))}`];
  });

  await add("GET /ssh_keys", "/ssh_keys", { per_page: 50 }, "ssh_keys", ["id", "name", "fingerprint", "public_key"], (rows) =>
    rows.map((k) => (k.name === EXPECTED_SSH_KEY ? `key ${String(k.name)}` : `UNEXPECTED key ${String(k.name)} (id ${String(k.id)}): only ${EXPECTED_SSH_KEY} should be here`))
  );

  const servers = await add("GET /servers", "/servers", { per_page: 50 }, "servers", ["id", "name", "status", "server_type.name", "location.name", "public_net.ipv4", "public_net.ipv6", "rescue_enabled", "labels"], (rows) => {
    if (rows.length === 0) return [];
    try {
      const s = toServer(rows[0] as never);
      const foreign = rows.map((r) => toServer(r as never)).filter((r) => !isOurServer(r, ownServerIds));
      return [`parsed ${s.name}: ${s.location}, ${s.ipv4}, ${s.ipv6Network}, Primary IPs ${s.primaryIpIds.join(", ") || "none"}`, ...foreign.map((r) => `NOT OURS: server ${r.id} ${r.name} (${r.ipv4})`)];
    } catch (err) {
      return [`toServer can't parse this answer: ${err instanceof Error ? err.message : String(err)}`];
    }
  });

  const floatingIps = await add("GET /floating_ips", "/floating_ips", { per_page: 50 }, "floating_ips", ["id", "ip", "description", "server", "home_location.name", "blocked"], (rows) => floatingIpFlags(rows, nodes));
  const volumes = await add("GET /volumes", "/volumes", { per_page: 50 }, "volumes", ["id", "name", "size", "assignee", "location.name"]);

  const primaryIps = await add("GET /primary_ips", "/primary_ips", { per_page: 50 }, "primary_ips", ["id", "ip", "type", "assignee_id", "auto_delete", "location.name"], (rows) => {
    const loose = rows.filter((ip) => ip.assignee_id === null);
    return loose.length ? loose.map((ip) => `UNATTACHED Primary IP ${String(ip.id)} (${String(ip.ip)}, ${String(ip.type)}) — bills hourly until deleted`) : ["no unattached Primary IPs"];
  });

  // Action polling: the newest action of one of our servers, read the way waitForAction reads it.
  const first = servers[0] as { id?: number } | undefined;
  if (first?.id) {
    const actions = await add(`GET /servers/${first.id}/actions`, `/servers/${first.id}/actions`, { per_page: 1, sort: "id:desc" }, "actions", ["id", "command", "status"]);
    const action = actions[0] as { id?: number } | undefined;
    if (action?.id) await add("GET /actions/{id}", `/actions/${action.id}`, undefined, "action", ["id", "status", "error"]);
  }

  for (const id of expectGone) results.push(await expectGoneCheck(get, id, { servers, floatingIps, volumes, primaryIps }));
  return results;
}

type Row = Record<string, unknown>;
const FIP_HOURLY = `$${HETZNER_INVOICE.floatingIpv4UsdHourly}/hour, up to $${HETZNER_INVOICE.floatingIpv4UsdMonthlyMax.toFixed(2)}/month`;

/** Every Floating IP should sit on a registered node in service. Anything else is billed for nothing, or is someone else's. */
export function floatingIpFlags(rows: Row[], nodes: RegisteredNodes | undefined): string[] {
  const known = nodes && Array.isArray(nodes) ? nodes : null;
  const lines: string[] = [];
  if (!known) lines.push(`registered nodes unknown${nodes && "problem" in nodes ? ` (${nodes.problem})` : ""}: only unassigned Floating IPs can be flagged`);
  for (const f of rows) {
    const name = `Floating IP ${String(f.id)} (${String(f.ip)}${f.description ? `, "${String(f.description)}"` : ""})`;
    if (f.server === null || f.server === undefined) {
      lines.push(`FLAG ${name} is unassigned: billed ${FIP_HOURLY} until it's released`);
      continue;
    }
    if (!known) continue;
    const node = known.find((n) => n.hetznerServerId === String(f.server));
    if (!node) lines.push(`FLAG ${name} is on server ${String(f.server)}, which isn't a registered node`);
    else if (isRetired(node)) lines.push(`FLAG ${name} is on ${node.name}, a retired node`);
    else lines.push(`${name} on node ${node.name}`);
  }
  if (rows.length === 0) lines.push("no Floating IPs");
  return lines;
}

const statusOf = (err: unknown) => (err as { response?: { status?: number } }).response?.status;

/** Proof that a removed server left nothing billed behind: the server, its IPs and its Volumes. */
async function expectGoneCheck(get: HetznerGet, id: string, seen: { servers: Row[]; floatingIps: Row[]; volumes: Row[]; primaryIps: Row[] }): Promise<CheckResult> {
  const endpoint = `EXPECT GONE: server ${id}`;
  const left: string[] = [];
  const notes: string[] = [];
  if (!/^\d+$/.test(id)) return { endpoint, ok: false, detail: `"${id}" isn't a server id`, fields: [], missing: [], notes };
  try {
    const server = ((await get(`/servers/${id}`)) as { server?: Row }).server;
    left.push(`server ${id} still exists${server?.name ? ` (${String(server.name)})` : ""}`);
  } catch (err) {
    if (statusOf(err) === 404) notes.push(`GET /servers/${id}: 404, the server is gone`);
    else left.push(`GET /servers/${id} couldn't tell: ${errorOf(err)}`);
  }
  if (seen.servers.some((sv) => String(sv.id) === id)) left.push(`server ${id} is still in the server list`);
  for (const ip of seen.primaryIps) {
    if (String(ip.assignee_id) === id) left.push(`Primary IP ${String(ip.id)} (${String(ip.ip)}) is still on server ${id}`);
    else if (ip.assignee_id === null) left.push(`Primary IP ${String(ip.id)} (${String(ip.ip)}, ${String(ip.type)}) is unattached and bills hourly: if it was this server's, remove it in the console`);
  }
  for (const f of seen.floatingIps) if (String(f.server) === id) left.push(`Floating IP ${String(f.id)} (${String(f.ip)}) is still on server ${id}`);
  for (const v of seen.volumes) if (String(v.server ?? (v.assignee as Row | null)?.id) === id) left.push(`Volume ${String(v.id)} (${String(v.name)}) is still attached to server ${id}`);
  try {
    const images = ((await get("/images", { type: "snapshot", per_page: 50 })) as { images?: Row[] }).images ?? [];
    const own = images.filter((im) => String((im.created_from as Row | null)?.id) === id);
    for (const im of own) notes.push(`snapshot ${String(im.id)} (${String(im.description ?? "")}) of server ${id} still exists: billed until removed, so keep it only on purpose`);
    if (own.length === 0) notes.push(`no snapshots of server ${id}`);
  } catch (err) {
    notes.push(`snapshots couldn't be read: ${errorOf(err)}`);
  }
  if (left.length === 0) notes.push(`no Primary IP, Floating IP or Volume left on server ${id}, and no unattached Primary IPs`);
  return { endpoint, ok: left.length === 0, detail: left.length ? `NOT gone: ${left.length} thing(s) left` : "gone, and nothing it held is left", fields: [], missing: [], notes: [...left.map((l) => `LEFT ${l}`), ...notes] };
}

export function formatResults(results: CheckResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.ok ? "OK  " : "FAIL"} ${r.endpoint}: ${r.detail}`);
    if (r.fields.length) lines.push(`       reads: ${r.fields.join(", ")}`);
    if (r.missing.length) lines.push(`       MISSING: ${r.missing.join(", ")}`);
    for (const n of r.notes) lines.push(`       ${n}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  const flags = results.flatMap((r) => r.notes).filter((n) => n.startsWith("FLAG ")).length;
  if (flags) lines.push("", `${flags} flag(s): see the FLAG lines above.`);
  lines.push("", failed ? `${failed} of ${results.length} checks failed.` : `All ${results.length} checks passed. Nothing was created, changed or deleted.`);
  return lines.join("\n");
}
