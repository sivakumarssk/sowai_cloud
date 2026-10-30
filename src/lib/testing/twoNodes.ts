// Two simulated Proxmox nodes that reuse the same VM ids, under the real billing,
// provisioning and engine code. Each node has its own containers and accepts only
// its own API token, so acting on the wrong node, or with the wrong token, shows up.
//
// Import this FIRST in a test: it replaces the database client and axios's transport
// before the code under test loads (the same globalThis.prisma that src/lib/prisma.ts reuses).
import axios, { AxiosError, type AxiosAdapter } from "axios";

process.env.ENCRYPTION_KEY = "0".repeat(64);
process.env.PROXMOX_USER = "root@pam";
process.env.PROXMOX_TOKEN_ID = "first";
process.env.PROXMOX_TOKEN_SECRET = "node-1-env-secret";
process.env.PROXMOX_HOST = "10.0.0.1";
process.env.PROXMOX_NODE = "node-1";
for (const k of ["MS_TENANT_ID", "RESEND_API_KEY", "PROVISIONING_SSH_PRIVATE_KEY_PATH", "PROVISIONING_SSH_PRIVATE_KEY", "ADMIN_ALERT_EMAIL"]) delete process.env[k];

export type Ct = { status: "running" | "stopped"; onboot: boolean; name: string; memoryMB: number; memUsedMB: number };
type NodeRow = { id: string; name: string; ip: string; status: string; apiTokenId: string | null; apiTokenSecret: string | null };
type ProxmoxRequest = { host: string; method: string; path: string };
type Row = Record<string, unknown> & { id: string };

export const cluster = {
  containers: new Map<string, Map<number, Ct>>(),
  tokens: new Map<string, string>(),
  requests: [] as ProxmoxRequest[],
};

export const db = {
  nodes: [] as NodeRow[],
  services: [] as Row[],
  metrics: [] as Record<string, unknown>[],
  logs: [] as Record<string, unknown>[],
};

/** Prisma's `where` for the shapes this code uses: equals, not, in, notIn, lt, OR. */
function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; in?: unknown[]; notIn?: unknown[]; lt?: Date };
      if ("not" in c && v === c.not) return false;
      if (c.in && !c.in.includes(v)) return false;
      if (c.notIn && c.notIn.includes(v)) return false;
      if (c.lt && !(v instanceof Date && v < c.lt)) return false;
      return true;
    }
    return v === cond;
  });
}

const withNode = (r: Row) => ({ ...r, node: db.nodes.find((n) => n.id === r.nodeId) ?? null });

const fakePrisma = {
  service: {
    async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      const rows = db.services.filter((r) => matches(r, where));
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const r = db.services.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      return withNode(r);
    },
    async findUnique({ where }: { where: { id: string } }) {
      const r = db.services.find((x) => x.id === where.id);
      return r ? withNode(r) : null;
    },
    async findUniqueOrThrow({ where }: { where: { id: string } }) {
      return withNode(db.services.find((x) => x.id === where.id)!);
    },
    async findMany({ where }: { where?: Record<string, unknown> } = {}) {
      return db.services.filter((r) => matches(r, where)).map(withNode);
    },
    async findFirst({ where }: { where?: Record<string, unknown> } = {}) {
      const r = db.services.find((x) => matches(x, where));
      return r ? withNode(r) : null;
    },
  },
  proxmoxNode: {
    findUnique: async ({ where }: { where: { name?: string; id?: string } }) => db.nodes.find((n) => n.name === where.name) ?? null,
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => db.nodes.filter((n) => matches(n, where)),
  },
  subscription: { findMany: async () => [], findFirst: async () => null },
  notification: { create: async () => ({}) },
  engineLog: { create: async ({ data }: { data: Record<string, unknown> }) => void db.logs.push(data) },
  resourceMetric: { createMany: async ({ data }: { data: Record<string, unknown>[] }) => void db.metrics.push(...data) },
  user: { findMany: async () => [] },
};

(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

const upid = (node: string) => `UPID:${node}:0001:task`;

function route(host: string, method: string, path: string, body: URLSearchParams): unknown {
  const node = db.nodes.find((n) => n.ip === host);
  const m = /^\/nodes\/([^/]+)(\/.*)?$/.exec(path);
  if (!node || !m || m[1] !== node.name) throw Object.assign(new Error(`${path} sent to ${host}`), { status: 500 });
  const rest = m[2] ?? "";
  const containers = cluster.containers.get(node.name)!;

  if (rest.startsWith("/tasks/")) return { status: "stopped", exitstatus: "OK" };
  if (rest === "/lxc" && method === "get") {
    return [...containers].map(([vmid, c]) => ({ vmid, name: c.name, status: c.status, mem: c.memUsedMB * 1024 ** 2, maxmem: c.memoryMB * 1024 ** 2, disk: 0, maxdisk: 40 * 1024 ** 3, cpu: 0.01, cpus: 1 }));
  }
  if (rest === "/storage" && method === "get") return [{ storage: "local", active: 1, enabled: 1 }];
  if (rest === "/storage/local/content" && method === "get") {
    return [...containers.keys()].map((vmid) => ({ volid: `local:${vmid}/vm-${vmid}-disk-0.raw`, content: "rootdir", vmid, size: 1 }));
  }

  const lxc = /^\/lxc\/(\d+)(\/.*)?$/.exec(rest);
  if (lxc) {
    const vmid = Number(lxc[1]);
    const ct = containers.get(vmid);
    if (!ct) throw Object.assign(new Error(`Configuration file 'nodes/${node.name}/lxc/${vmid}.conf' does not exist`), { status: 500 });
    switch (`${method} ${lxc[2] ?? ""}`) {
      case "get /status/current": return { status: ct.status };
      case "get /config": return { memory: ct.memoryMB, onboot: ct.onboot ? 1 : 0 };
      case "get /pending": return [{ key: "rootfs", value: `local:${vmid}/vm-${vmid}-disk-0.raw,size=40G` }];
      case "put /config":
        if (body.has("onboot")) ct.onboot = body.get("onboot") === "1";
        if (body.has("memory")) ct.memoryMB = Number(body.get("memory"));
        return upid(node.name);
      case "post /status/shutdown":
      case "post /status/stop":
        ct.status = "stopped";
        return upid(node.name);
      case "post /status/start":
        ct.status = "running";
        return upid(node.name);
      case "delete ":
        containers.delete(vmid);
        return upid(node.name);
    }
  }
  throw Object.assign(new Error(`no route ${method} ${path}`), { status: 501 });
}

const adapter: AxiosAdapter = async (config) => {
  const host = new URL(config.baseURL ?? "https://none").hostname;
  const method = (config.method ?? "get").toLowerCase();
  const path = config.url ?? "";
  cluster.requests.push({ host, method, path });
  const body = new URLSearchParams(typeof config.data === "string" ? config.data : "");
  const expected = cluster.tokens.get(host);
  const fail = (status: number, message: string) => {
    const response = { status, statusText: String(status), data: { message }, headers: {}, config };
    return new AxiosError(message, "ERR_BAD_RESPONSE", config, null, response);
  };
  if (!expected || String(config.headers.Authorization) !== `PVEAPIToken=${expected}`) throw fail(401, "authentication failure");
  try {
    return { status: 200, statusText: "OK", data: { data: route(host, method, path, body) }, headers: {}, config };
  } catch (err) {
    throw fail((err as { status?: number }).status ?? 500, (err as Error).message);
  }
};
axios.defaults.adapter = adapter;

export const requestsTo = (host: string) => cluster.requests.filter((r) => r.host === host);
export const writesTo = (host: string) => requestsTo(host).filter((r) => r.method !== "get");
