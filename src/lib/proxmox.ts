import https from "node:https";
import axios, { AxiosError, type AxiosInstance } from "axios";

export type CreateLXCInput = {
  vmid: number;
  hostname: string;
  cores: number;
  /** MB */
  memory: number;
  /** GB */
  diskSize: number;
  /** Matches OS_IMAGES values in provisioning/catalog.ts, e.g. "ubuntu-22.04" */
  osTemplate: string;
  /** Public IPv4 (a Hetzner Floating IP), configured as {ip}/32 with an on-link gateway. */
  ipv4?: string;
  /** Public IPv6 from the server's /64, configured as {ip}/64. */
  ipv6?: string;
  /** Start the container as soon as it's created. */
  start?: boolean;
};

export type LXCStatus = {
  status: string;
  /** CPU usage as a fraction of allocated cores (0–1) */
  cpu: number;
  /** Bytes */
  mem: number;
  maxmem: number;
  /** Bytes */
  disk: number;
  maxdisk: number;
  uptime: number;
};

export class ProxmoxError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ProxmoxError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Proxmox appliance templates (`pveam available`) per OS_IMAGES value.
 * Only Debian-family images: VM setup uses apt. Override one with
 * PROXMOX_LXC_TEMPLATE_<OS>, e.g. PROXMOX_LXC_TEMPLATE_UBUNTU_22_04.
 */
const LXC_TEMPLATES: Record<string, string> = {
  "ubuntu-22.04": "ubuntu-22.04-standard_22.04-1_amd64.tar.zst",
  "ubuntu-24.04": "ubuntu-24.04-standard_24.04-2_amd64.tar.zst",
  "debian-12": "debian-12-standard_12.12-1_amd64.tar.zst",
};

function isUpid(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("UPID:");
}

export class ProxmoxService {
  private client: AxiosInstance | null = null;

  // Config is read on first use rather than at import time so a missing env
  // var doesn't break `next build` for every route that imports this module.
  private get node(): string {
    return requireEnv("PROXMOX_NODE");
  }

  /** Where container root disks live. */
  private get storage(): string {
    return process.env.PROXMOX_STORAGE || "local";
  }

  /** Where downloaded LXC templates live. */
  private get templateStorage(): string {
    return process.env.PROXMOX_TEMPLATE_STORAGE || "local";
  }

  /** Routed bridge with no physical port — see scripts/proxmox-host-setup.sh. */
  private get bridge(): string {
    return process.env.PROXMOX_BRIDGE || "vmbr1";
  }

  private api(): AxiosInstance {
    if (this.client) return this.client;

    const host = requireEnv("PROXMOX_HOST");
    const port = process.env.PROXMOX_PORT || "8006";
    const user = requireEnv("PROXMOX_USER");
    const tokenId = requireEnv("PROXMOX_TOKEN_ID");
    const secret = requireEnv("PROXMOX_TOKEN_SECRET");

    this.client = axios.create({
      baseURL: `https://${host}:${port}/api2/json`,
      timeout: 30_000,
      headers: { Authorization: `PVEAPIToken=${user}!${tokenId}=${secret}` },
      // Proxmox ships a self-signed cert. Set PROXMOX_VERIFY_TLS=true once a
      // real certificate is installed on the host.
      httpsAgent: new https.Agent({ rejectUnauthorized: process.env.PROXMOX_VERIFY_TLS === "true" }),
    });
    return this.client;
  }

  private async request<T>(
    method: "get" | "post" | "put" | "delete",
    path: string,
    params?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined) clean[k] = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
    }

    try {
      // Proxmox expects form-encoded bodies for writes and query params for reads/deletes.
      const res =
        method === "get" || method === "delete"
          ? await this.api().request({ method, url: path, params: clean })
          : await this.api().request({
              method,
              url: path,
              data: new URLSearchParams(clean).toString(),
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
            });
      return res.data?.data as T;
    } catch (err) {
      throw toProxmoxError(err, `${method.toUpperCase()} ${path}`);
    }
  }

  /** Waits for an async Proxmox task (UPID) to finish and throws if it failed. */
  private async waitForTask(upid: string, timeoutMs = 10 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const path = `/nodes/${this.node}/tasks/${encodeURIComponent(upid)}/status`;

    while (Date.now() < deadline) {
      const task = await this.request<{ status: string; exitstatus?: string }>("get", path);
      if (task.status === "stopped") {
        if (task.exitstatus !== "OK") {
          throw new ProxmoxError(`Proxmox task failed: ${task.exitstatus ?? "unknown error"} (${upid})`);
        }
        return;
      }
      await sleep(2000);
    }
    throw new ProxmoxError(`Timed out waiting for Proxmox task ${upid}`);
  }

  private async runTask(
    method: "post" | "put" | "delete",
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    timeoutMs?: number
  ): Promise<void> {
    const result = await this.request<unknown>(method, path, params);
    if (isUpid(result)) await this.waitForTask(result, timeoutMs);
  }

  async getVersion(): Promise<{ version: string; release: string; repoid: string }> {
    return this.request("get", "/version");
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.getVersion();
      await this.request("get", `/nodes/${this.node}/status`);
      return true;
    } catch (err) {
      console.error("[proxmox] connection test failed:", err instanceof Error ? err.message : err);
      return false;
    }
  }

  async getNextVMID(): Promise<number> {
    const id = await this.request<string | number>("get", "/cluster/nextid");
    return Number(id);
  }

  /** Template file name for an OS, or null if the OS isn't supported. */
  getTemplateFile(osTemplate: string): string | null {
    const envKey = `PROXMOX_LXC_TEMPLATE_${osTemplate.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    return process.env[envKey] || LXC_TEMPLATES[osTemplate] || null;
  }

  /** True when the OS's template has been downloaded to the template storage. */
  async hasOSTemplate(osTemplate: string): Promise<boolean> {
    const file = this.getTemplateFile(osTemplate);
    if (!file) return false;
    const content = await this.request<{ volid: string }[]>(
      "get",
      `/nodes/${this.node}/storage/${this.templateStorage}/content`,
      { content: "vztmpl" }
    );
    return content.some((c) => c.volid === `${this.templateStorage}:vztmpl/${file}`);
  }

  /** Equivalent of `pveam download <storage> <template>`. */
  async downloadOSTemplate(osTemplate: string): Promise<void> {
    const file = this.getTemplateFile(osTemplate);
    if (!file) throw new ProxmoxError(`No LXC template known for OS "${osTemplate}"`);
    await this.runTask("post", `/nodes/${this.node}/aplinfo`, { storage: this.templateStorage, template: file }, 15 * 60_000);
  }

  /**
   * Creates an unprivileged container with nesting (needed for Docker), the
   * platform SSH key for root, and static public IPs on the routed bridge.
   * Proxmox writes the guest's network config itself, including the on-link
   * route needed for a /32 address whose gateway is outside its subnet.
   */
  async createLXC(input: CreateLXCInput): Promise<{ vmid: number; status: string }> {
    const file = this.getTemplateFile(input.osTemplate);
    if (!file) throw new ProxmoxError(`No LXC template known for OS "${input.osTemplate}"`);

    const gw4 = process.env.PROXMOX_GATEWAY4 || "172.31.1.1";
    const gw6 = process.env.PROXMOX_GATEWAY6 || "fe80::1";
    const net0 = [
      "name=eth0",
      `bridge=${this.bridge}`,
      ...(input.ipv4 ? [`ip=${input.ipv4}/32`, `gw=${gw4}`] : []),
      ...(input.ipv6 ? [`ip6=${input.ipv6}/64`, `gw6=${gw6}`] : []),
    ].join(",");

    try {
      await this.runTask(
        "post",
        `/nodes/${this.node}/lxc`,
        {
          vmid: input.vmid,
          hostname: input.hostname,
          ostemplate: `${this.templateStorage}:vztmpl/${file}`,
          cores: input.cores,
          memory: input.memory,
          rootfs: `${this.storage}:${input.diskSize}`,
          net0,
          "ssh-public-keys": requireEnv("PROVISIONING_SSH_PUBLIC_KEY").trim(),
          unprivileged: true,
          features: process.env.PROXMOX_LXC_FEATURES || "nesting=1",
          onboot: true,
          start: input.start ?? false,
        },
        15 * 60_000
      );
    } catch (err) {
      // "already exists" means another job owns this ID — never touch it.
      // Anything else may have left a half-created container behind; callers
      // only learn the ID on success, so clean it up here.
      if (!(err instanceof ProxmoxError && /already exists/i.test(err.message))) {
        await this.deleteLXC(input.vmid).catch((cleanupErr) =>
          console.error(`[proxmox] failed to remove half-created container ${input.vmid}:`, cleanupErr)
        );
      }
      throw err;
    }

    return { vmid: input.vmid, status: input.start ? "running" : "stopped" };
  }

  async startLXC(vmid: number): Promise<void> {
    await this.runTask("post", `/nodes/${this.node}/lxc/${vmid}/status/start`);
  }

  /** Hard stop (equivalent to pulling the power). */
  async stopLXC(vmid: number): Promise<void> {
    await this.runTask("post", `/nodes/${this.node}/lxc/${vmid}/status/stop`);
  }

  /** Stops the container if needed, then destroys it and its disks. A container that no longer exists counts as deleted. */
  async deleteLXC(vmid: number): Promise<void> {
    let status: string;
    try {
      ({ status } = await this.getLXCStatus(vmid));
    } catch (err) {
      if (err instanceof ProxmoxError && /does not exist/i.test(err.message)) return;
      throw err;
    }
    if (status === "running") await this.stopLXC(vmid);

    await this.runTask("delete", `/nodes/${this.node}/lxc/${vmid}`, {
      purge: true,
      "destroy-unreferenced-disks": true,
    });
  }

  async getLXCStatus(vmid: number): Promise<LXCStatus> {
    const s = await this.request<Partial<LXCStatus>>("get", `/nodes/${this.node}/lxc/${vmid}/status/current`);
    return {
      status: s.status ?? "unknown",
      cpu: s.cpu ?? 0,
      mem: s.mem ?? 0,
      maxmem: s.maxmem ?? 0,
      disk: s.disk ?? 0,
      maxdisk: s.maxdisk ?? 0,
      uptime: s.uptime ?? 0,
    };
  }

  /** The container's net0 line, e.g. "name=eth0,bridge=vmbr1,ip=1.2.3.4/32,...". */
  async getLXCNetConfig(vmid: number): Promise<string | null> {
    const config = await this.request<{ net0?: string }>("get", `/nodes/${this.node}/lxc/${vmid}/config`);
    return config.net0 ?? null;
  }

  /** Polls every 5 seconds until the container reports "running"; times out after 5 minutes. */
  async waitForLXC(vmid: number, timeoutMs = 5 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { status } = await this.getLXCStatus(vmid);
      if (status === "running") return;
      await sleep(5000);
    }
    throw new ProxmoxError(`Container ${vmid} did not reach "running" within ${timeoutMs / 1000}s`);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ProxmoxError(`${name} is not set`);
  return value;
}

function toProxmoxError(err: unknown, context: string): ProxmoxError {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const body = err.response?.data as { errors?: Record<string, string>; message?: string } | undefined;
    const detail =
      (body?.errors && Object.entries(body.errors).map(([k, v]) => `${k}: ${v}`).join("; ")) ||
      body?.message?.trim() ||
      err.response?.statusText ||
      err.message;
    return new ProxmoxError(`${context} failed${status ? ` (${status})` : ""}: ${detail}`, status);
  }
  return new ProxmoxError(`${context} failed: ${err instanceof Error ? err.message : String(err)}`);
}

export const proxmox = new ProxmoxService();
