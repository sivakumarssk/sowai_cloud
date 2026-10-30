// A simulated Hetzner Cloud API at the HTTP level (an axios adapter), so the real
// HetznerService code runs in tests, including its response parsing.
//
// Shapes come from the live API (GET /server_types?name=cpx22 and GET /locations,
// read from the account) and Hetzner's OpenAPI spec (docs.hetzner.cloud/cloud.spec.json).
// Removed things behave as they do live: /datacenters answers 410, and servers
// have `location` and no datacenter property.
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";

export type RecordedRequest = { method: string; path: string; params: Record<string, unknown>; body: Record<string, unknown> | undefined };

/** Paths and fields Hetzner removed or deprecated. Nothing we send may match. */
export function deprecatedUse(r: RecordedRequest): string[] {
  const found: string[] = [];
  if (/^\/datacenters(\/|$)/.test(r.path)) found.push(`${r.path}: the Data Center endpoints were removed (410 since 2026-10-01)`);
  if (r.method === "GET" && r.path === "/actions" && r.params.id === undefined) found.push("GET /actions without id: removed (410 since 2025-01-30)");
  if (r.method === "GET" && /^\/[a-z_]+\/\d+\/actions\/\d+$/.test(r.path)) found.push(`GET ${r.path}: resource action GETs are deprecated; use GET /actions/{id}`);
  if (r.body && "datacenter" in r.body) found.push(`${r.path}: the datacenter property was removed (2026-07-01)`);
  if (r.body && /^\/volumes(\/\d+\/actions\/attach)?$/.test(r.path) && "server" in r.body) found.push(`${r.path}: Volume server is deprecated; use assignee (removed 2027-10-27)`);
  if (r.path === "/volumes" && r.body && "automount" in r.body && !r.body.assignee) found.push("POST /volumes: automount needs a server to attach to");
  return found;
}

const price = (hourly: string, monthly: string) => ({ price_hourly: { gross: hourly, net: hourly }, price_monthly: { gross: monthly, net: monthly } });

export const LOCATIONS = {
  nbg1: { id: 2, name: "nbg1", city: "Nuremberg", country: "DE", description: "Nuremberg DC Park 1", latitude: 49.452102, longitude: 11.076665, network_zone: "eu-central" },
  fsn1: { id: 1, name: "fsn1", city: "Falkenstein", country: "DE", description: "Falkenstein DC Park 1", latitude: 50.47612, longitude: 12.370071, network_zone: "eu-central" },
};

/** The live answer for cpx22; `locations` is what availability is read from. */
export const CPX22 = {
  id: 109,
  name: "cpx22",
  description: "CPX 22",
  cores: 2,
  memory: 4,
  disk: 80,
  deprecated: false,
  architecture: "x86",
  cpu_type: "shared",
  storage_type: "local",
  prices: [
    { location: "nbg1", ...price("0.0368", "22.99"), included_traffic: 2199023255552, price_per_tb_traffic: { gross: "1.00", net: "1.00" } },
    { location: "fsn1", ...price("0.0368", "22.99"), included_traffic: 2199023255552, price_per_tb_traffic: { gross: "1.00", net: "1.00" } },
  ],
  locations: [
    { id: 2, name: "nbg1", available: true, recommended: true, deprecation: null as { announced: string; unavailable_after: string } | null },
    { id: 1, name: "fsn1", available: true, recommended: false, deprecation: null as { announced: string; unavailable_after: string } | null },
  ],
};

export type FakeHetznerConfig = {
  /** Replaces GET /server_types entries (e.g. an unavailable or deprecated cpx22). */
  serverTypes?: Record<string, unknown>[];
  /** POST /servers answers with this error. */
  createError?: { status: number; code: string; message: string };
  /** GET /server_types answers with this error. */
  serverTypesError?: { status: number; code: string; message: string };
  /** GET /pricing answers with this error. */
  pricingError?: { status: number; code: string; message: string };
  /** Server delete leaves its Primary IPs behind, unassigned (auto_delete off). */
  primaryIpsSurviveDelete?: boolean;
  /** Primary IPs can't be deleted. */
  primaryIpDeleteFails?: boolean;
  /** Action polling: answer "running" this many times first. */
  actionPollsRunning?: number;
};

type Row = Record<string, unknown> & { id: number };

export function fakeHetzner(cfg: FakeHetznerConfig = {}) {
  let nextId = 5000;
  const id = () => nextId++;
  const state = {
    servers: new Map<number, Row>(),
    primaryIps: new Map<number, Row>(),
    sshKeys: new Map<number, Row>(),
    floatingIps: new Map<number, Row>(),
    volumes: new Map<number, Row>(),
    actions: new Map<number, { row: Row; polls: number }>(),
  };
  const requests: RecordedRequest[] = [];

  const action = (command: string) => {
    const row: Row = { id: id(), command, status: "success", progress: 100, started: "2026-10-30T10:00:00+00:00", finished: "2026-10-30T10:00:01+00:00", error: null, resources: [] };
    state.actions.set(row.id, { row, polls: cfg.actionPollsRunning ?? 0 });
    return (cfg.actionPollsRunning ?? 0) > 0 ? { ...row, status: "running", progress: 0, finished: null } : row;
  };
  const meta = (n: number) => ({ meta: { pagination: { page: 1, per_page: 50, previous_page: null, next_page: null, last_page: 1, total_entries: n } } });
  class Reply extends Error {
    constructor(readonly status: number, readonly code: string, msg: string) {
      super(msg);
    }
  }
  const notFound = () => new Reply(404, "not_found", "resource not found");
  const list = (key: string, rows: Row[]) => ({ [key]: rows, ...meta(rows.length) });

  function route(method: string, path: string, params: Record<string, unknown>, body: Record<string, unknown>): { status: number; data: unknown } {
    const ok = (data: unknown, status = 200) => ({ status, data });
    let m: RegExpExecArray | null;

    if (/^\/datacenters(\/|$)/.test(path)) throw new Reply(410, "deprecated_api_endpoint", "API functionality was removed");
    if (path === "/actions" && method === "GET" && params.id === undefined) throw new Reply(410, "deprecated_api_endpoint", "API functionality was removed");

    if ((m = /^\/actions\/(\d+)$/.exec(path)) && method === "GET") {
      const a = state.actions.get(Number(m[1]));
      if (!a) throw notFound();
      if (a.polls > 0) {
        a.polls--;
        return ok({ action: { ...a.row, status: "running", progress: 50, finished: null } });
      }
      return ok({ action: a.row });
    }

    if (path === "/locations" && method === "GET") return ok(list("locations", Object.values(LOCATIONS)));
    if (path === "/server_types" && method === "GET") {
      if (cfg.serverTypesError) throw new Reply(cfg.serverTypesError.status, cfg.serverTypesError.code, cfg.serverTypesError.message);
      const rows = (cfg.serverTypes ?? [CPX22]).filter((t) => !params.name || t.name === params.name);
      return ok({ server_types: rows, ...meta(rows.length) });
    }
    if (path === "/pricing" && method === "GET") {
      if (cfg.pricingError) throw new Reply(cfg.pricingError.status, cfg.pricingError.code, cfg.pricingError.message);
      return ok({
        pricing: {
          currency: "EUR",
          vat_rate: "0.00",
          primary_ips: [
            { type: "ipv4", prices: [{ location: "nbg1", ...price("0.0008", "0.50") }] },
            { type: "ipv6", prices: [{ location: "nbg1", ...price("0.0000", "0.00") }] },
          ],
          floating_ips: [{ type: "ipv4", prices: [{ location: "nbg1", price_monthly: { gross: "3.57", net: "3.57" } }] }],
          floating_ip: { price_monthly: { gross: "3.57", net: "3.57" } },
          volume: { price_per_gb_month: { gross: "0.05", net: "0.05" } },
          server_types: [{ id: CPX22.id, name: CPX22.name, prices: CPX22.prices }],
        },
      });
    }

    // ── servers ──
    if (path === "/servers" && method === "POST") {
      if (cfg.createError) throw new Reply(cfg.createError.status, cfg.createError.code, cfg.createError.message);
      if ("datacenter" in body) throw new Reply(422, "invalid_input", "invalid input: datacenter");
      for (const k of ["name", "server_type", "image"]) if (!body[k]) throw new Reply(422, "invalid_input", `missing ${k}`);
      if ([...state.servers.values()].some((s) => s.name === body.name)) throw new Reply(409, "uniqueness_error", "server name is already used");
      const loc = LOCATIONS[body.location as keyof typeof LOCATIONS];
      if (!loc) throw new Reply(422, "invalid_input", "unknown location");
      const type = (cfg.serverTypes ?? [CPX22]).find((t) => t.name === body.server_type);
      if (!type) throw new Reply(422, "invalid_input", "unknown server type");
      const serverId = id();
      const ipv4Id = id();
      const ipv6Id = id();
      const base = { assignee_type: "server", assignee_id: serverId, auto_delete: true, blocked: false, location: loc, labels: {}, name: `primary-${serverId}`, dns_ptr: [] };
      state.primaryIps.set(ipv4Id, { id: ipv4Id, ip: "203.0.113.20", type: "ipv4", ...base });
      state.primaryIps.set(ipv6Id, { id: ipv6Id, ip: "2a01:4f8:1c1c:abcd::/64", type: "ipv6", ...base });
      const server: Row = {
        id: serverId,
        name: body.name,
        status: "initializing",
        created: "2026-10-30T10:00:00+00:00",
        public_net: {
          ipv4: { id: ipv4Id, ip: "203.0.113.20", blocked: false, dns_ptr: "static.20.113.0.203.clients.your-server.de" },
          ipv6: { id: ipv6Id, ip: "2a01:4f8:1c1c:abcd::/64", blocked: false, dns_ptr: [] },
          floating_ips: [],
          firewalls: [],
        },
        server_type: type,
        location: loc,
        labels: body.labels ?? {},
        backup_window: null,
        volumes: [],
      };
      state.servers.set(serverId, server);
      return ok({ server, action: action("create_server"), next_actions: [action("start_server")], root_password: null }, 201);
    }
    if (path === "/servers" && method === "GET") {
      const rows = [...state.servers.values()].filter((s) => !params.name || s.name === params.name);
      return ok(list("servers", rows));
    }
    if ((m = /^\/servers\/(\d+)$/.exec(path))) {
      const server = state.servers.get(Number(m[1]));
      if (!server) throw notFound();
      if (method === "GET") return ok({ server: { ...server, status: "running" } });
      if (method === "DELETE") {
        state.servers.delete(server.id);
        for (const ip of state.primaryIps.values()) {
          if (ip.assignee_id !== server.id) continue;
          if (cfg.primaryIpsSurviveDelete) Object.assign(ip, { assignee_id: null, assignee_type: "unassigned", auto_delete: false });
          else state.primaryIps.delete(ip.id);
        }
        return ok({ action: action("delete_server") });
      }
    }
    if ((m = /^\/servers\/(\d+)\/actions$/.exec(path)) && method === "GET") {
      const rows = [...state.actions.values()].map((a) => a.row);
      return ok(list("actions", rows));
    }

    // ── primary IPs ──
    if (path === "/primary_ips" && method === "GET") return ok(list("primary_ips", [...state.primaryIps.values()]));
    if ((m = /^\/primary_ips\/(\d+)$/.exec(path))) {
      const ip = state.primaryIps.get(Number(m[1]));
      if (!ip) throw notFound();
      if (method === "GET") return ok({ primary_ip: ip });
      if (method === "DELETE") {
        if (ip.assignee_id !== null) throw new Reply(422, "must_be_unassigned", "Primary IP is still assigned");
        if (cfg.primaryIpDeleteFails) throw new Reply(423, "locked", "resource is locked");
        state.primaryIps.delete(ip.id);
        return ok(undefined, 204);
      }
    }

    // ── SSH keys ──
    if (path === "/ssh_keys" && method === "GET") return ok(list("ssh_keys", [...state.sshKeys.values()]));
    if (path === "/ssh_keys" && method === "POST") {
      if (String(body.public_key).match(/^\s/)) throw new Reply(422, "invalid_input", "public_key has leading whitespace");
      if ([...state.sshKeys.values()].some((k) => k.name === body.name)) throw new Reply(409, "uniqueness_error", "name is already used");
      const key: Row = { id: id(), name: body.name, fingerprint: "b7:2f:30:a0:2f:6c:58:6c:21:04:58:61:ba:06:3b:2f", public_key: body.public_key, labels: body.labels ?? {} };
      state.sshKeys.set(key.id, key);
      return ok({ ssh_key: key }, 201);
    }
    if ((m = /^\/ssh_keys\/(\d+)$/.exec(path)) && method === "DELETE") {
      if (!state.sshKeys.delete(Number(m[1]))) throw notFound();
      return ok(undefined, 204);
    }

    // ── Floating IPs ──
    if (path === "/floating_ips" && method === "GET") return ok(list("floating_ips", [...state.floatingIps.values()]));
    if (path === "/floating_ips" && method === "POST") {
      const loc = LOCATIONS[body.home_location as keyof typeof LOCATIONS];
      if (!loc) throw new Reply(422, "invalid_input", "home_location");
      const fip: Row = { id: id(), name: `fip-${nextId}`, description: body.description ?? null, ip: "198.51.100.7", type: body.type, server: null, home_location: loc, blocked: false, labels: {}, dns_ptr: [] };
      state.floatingIps.set(fip.id, fip);
      return ok({ floating_ip: fip }, 201);
    }
    if ((m = /^\/floating_ips\/(\d+)$/.exec(path))) {
      const fip = state.floatingIps.get(Number(m[1]));
      if (!fip) throw notFound();
      if (method === "GET") return ok({ floating_ip: fip });
      if (method === "DELETE") {
        if (fip.server !== null) throw new Reply(422, "must_be_unassigned", "Floating IP is still assigned");
        state.floatingIps.delete(fip.id);
        return ok(undefined, 204);
      }
    }
    if ((m = /^\/floating_ips\/(\d+)\/actions\/(assign|unassign)$/.exec(path)) && method === "POST") {
      const fip = state.floatingIps.get(Number(m[1]));
      if (!fip) throw notFound();
      if (m[2] === "assign" && !body.server) throw new Reply(422, "invalid_input", "server is required");
      fip.server = m[2] === "assign" ? body.server : null;
      return ok({ action: action(`${m[2]}_floating_ip`) }, 201);
    }

    // ── Volumes ──
    if (path === "/volumes" && method === "GET") return ok(list("volumes", [...state.volumes.values()]));
    if (path === "/volumes" && method === "POST") {
      const loc = LOCATIONS[body.location as keyof typeof LOCATIONS];
      if (!loc || !body.size || !body.name) throw new Reply(422, "invalid_input", "size, name, location");
      const volume: Row = { id: id(), name: body.name, size: body.size, server: null, assignee: null, location: loc, linux_device: "/dev/disk/by-id/scsi-0HC_Volume_1", status: "available", format: body.format ?? null, labels: body.labels ?? {} };
      state.volumes.set(volume.id, volume);
      return ok({ volume, action: action("create_volume"), next_actions: [] }, 201);
    }
    if ((m = /^\/volumes\/(\d+)$/.exec(path))) {
      const volume = state.volumes.get(Number(m[1]));
      if (!volume) throw notFound();
      if (method === "GET") return ok({ volume });
      if (method === "DELETE") {
        state.volumes.delete(volume.id);
        return ok(undefined, 204);
      }
    }
    if ((m = /^\/volumes\/(\d+)\/actions\/(attach|detach)$/.exec(path)) && method === "POST") {
      const volume = state.volumes.get(Number(m[1]));
      if (!volume) throw notFound();
      if (m[2] === "attach") {
        const assignee = body.assignee as { id: number; type: string } | undefined;
        if (!assignee?.id || assignee.type !== "server") throw new Reply(422, "invalid_input", "assignee is required");
        Object.assign(volume, { assignee, server: assignee.id });
      } else {
        Object.assign(volume, { assignee: null, server: null });
      }
      return ok({ action: action(`${m[2]}_volume`) }, 201);
    }

    throw new Reply(404, "not_found", `no route ${method} ${path}`);
  }

  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const method = (config.method ?? "get").toUpperCase();
    const path = config.url ?? "";
    const params = (config.params ?? {}) as Record<string, unknown>;
    const body = config.data ? (JSON.parse(config.data as string) as Record<string, unknown>) : undefined;
    requests.push({ method, path, params, body });
    let status = 200;
    let data: unknown;
    try {
      ({ status, data } = route(method, path, params, body ?? {}));
    } catch (err) {
      if (!(err instanceof Reply)) throw err;
      status = err.status;
      data = { error: { code: err.code, message: err.message, details: null } };
    }
    const response = { status, statusText: String(status), data, headers: {}, config };
    if (status >= 400) throw new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_REQUEST", config, null, response);
    return response;
  };

  return { adapter, state, requests };
}
