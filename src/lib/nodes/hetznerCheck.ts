// What scripts/node/hetzner-check.ts does: read every Hetzner endpoint we depend
// on and report whether it answers and whether the fields we read are there.
// Takes a GET function, so nothing here can create, change or delete anything.
import { serverTypeOffer, toServer, type ApiServerType } from "@/lib/hetzner";

const INSTALL_LABEL = "sowsi-node-install";

/** The only thing this module can do to Hetzner. */
export type HetznerGet = (path: string, params?: Record<string, string | number>) => Promise<unknown>;

/** The only SSH key that should stay in the project. */
export const EXPECTED_SSH_KEY = "sowsi-hosting";

/** Created by the installer, node 1 or the management server. */
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
export async function runHetznerChecks(get: HetznerGet, opts: { serverType: string; location: string; ownServerIds?: string[] }): Promise<CheckResult[]> {
  const { serverType, location, ownServerIds = [] } = opts;
  const results: CheckResult[] = [];
  const add = async (...args: Parameters<typeof check> extends [HetznerGet, ...infer R] ? R : never) => {
    const r = await check(get, ...args);
    results.push(r.result);
    return r.rows;
  };

  await add(`GET /server_types?name=${serverType}`, "/server_types", { name: serverType }, "server_types", ["id", "name", "architecture", "cores", "memory", "disk", "prices[].location", "prices[].price_hourly.gross", "prices[].price_monthly.gross", "locations[].name", "locations[].available", "locations[].deprecation"], (rows) => {
    if (rows.length === 0) return [`${serverType} is not a Hetzner server type`];
    const offer = serverTypeOffer(rows[0] as unknown as ApiServerType, location);
    return [
      offer.buyable ? `${serverType} is buyable in ${location}: $${offer.price!.monthly}/month, $${offer.price!.hourly}/hour (gross)` : `NOT buyable: ${offer.reason}`,
      `architecture ${String(rows[0].architecture)}${rows[0].architecture === "x86" ? "" : " — Proxmox needs x86"}`,
    ];
  });

  await add("GET /locations", "/locations", undefined, "locations", ["name", "network_zone"], (rows) => {
    const here = rows.find((l) => l.name === location);
    return [here ? `${location} is in ${String(here.network_zone)}` : `${location} is not in the list`];
  });

  await add("GET /pricing", "/pricing", undefined, "pricing", ["currency", "primary_ips[].type", "primary_ips[].prices[].location", "primary_ips[].prices[].price_hourly.gross", "primary_ips[].prices[].price_monthly.gross", "floating_ips[].type", "floating_ips[].prices[].location", "floating_ips[].prices[].price_monthly.gross"], (rows) => {
    const p = rows[0] as { currency?: string; primary_ips?: { type: string; prices: { location: string; price_monthly: { gross: string } }[] }[]; floating_ips?: { type: string; prices: { location: string; price_monthly: { gross: string } }[] }[] };
    const monthly = (list: typeof p.primary_ips) => list?.find((t) => t.type === "ipv4")?.prices.find((x) => x.location === location)?.price_monthly.gross;
    return [`currency ${String(p.currency)}${p.currency === "USD" ? "" : " — costs here are worked out from USD"}`, `Primary IPv4 in ${location}: $${monthly(p.primary_ips) ?? "?"}/month`, `Floating IPv4 in ${location}: $${monthly(p.floating_ips) ?? "?"}/month`];
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

  await add("GET /floating_ips", "/floating_ips", { per_page: 50 }, "floating_ips", ["id", "ip", "description", "server", "home_location.name", "blocked"]);
  await add("GET /volumes", "/volumes", { per_page: 50 }, "volumes", ["id", "name", "size", "assignee", "location.name"]);

  await add("GET /primary_ips", "/primary_ips", { per_page: 50 }, "primary_ips", ["id", "ip", "type", "assignee_id", "auto_delete", "location.name"], (rows) => {
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
  return results;
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
  lines.push("", failed ? `${failed} of ${results.length} checks failed.` : `All ${results.length} checks passed. Nothing was created, changed or deleted.`);
  return lines.join("\n");
}
