import axios, { AxiosError, type AxiosInstance } from "axios";

type HetznerAction = { id: number; status: "running" | "success" | "error"; error?: { code: string; message: string } };

export type FloatingIp = {
  id: number;
  ip: string;
  description: string | null;
  /** ID of the server it's assigned to, or null when unassigned. */
  server: number | null;
  homeLocation: string;
  blocked: boolean;
};

type ApiFloatingIp = {
  id: number;
  ip: string;
  description: string | null;
  server: number | null;
  home_location: { name: string };
  blocked: boolean;
};

export class HetznerError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "HetznerError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toFloatingIp(f: ApiFloatingIp): FloatingIp {
  return {
    id: f.id,
    ip: f.ip,
    description: f.description,
    server: f.server,
    homeLocation: f.home_location.name,
    blocked: f.blocked,
  };
}

/**
 * Hetzner Cloud API — Floating IPs routed to the Proxmox host.
 * Floating IPs only work with Hetzner *Cloud* servers; a Robot (dedicated)
 * server needs its additional IPs/subnets managed differently.
 */
export class HetznerService {
  private client: AxiosInstance | null = null;

  private api(): AxiosInstance {
    if (this.client) return this.client;
    const token = process.env.HETZNER_API_TOKEN;
    if (!token) throw new HetznerError("HETZNER_API_TOKEN is not set");
    this.client = axios.create({
      baseURL: "https://api.hetzner.cloud/v1",
      timeout: 30_000,
      headers: { Authorization: `Bearer ${token}` },
    });
    return this.client;
  }

  private async request<T>(
    method: "get" | "post" | "delete",
    path: string,
    { data, params }: { data?: unknown; params?: Record<string, string | number> } = {}
  ): Promise<T> {
    try {
      const res = await this.api().request({ method, url: path, data, params });
      return res.data as T;
    } catch (err) {
      if (err instanceof AxiosError) {
        const body = err.response?.data as { error?: { code: string; message: string } } | undefined;
        const detail = body?.error ? `${body.error.code}: ${body.error.message}` : err.message;
        throw new HetznerError(`${method.toUpperCase()} ${path} failed: ${detail}`, err.response?.status);
      }
      throw err;
    }
  }

  private async waitForAction(action: HetznerAction, timeoutMs = 2 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let current = action;
    while (current.status === "running") {
      if (Date.now() > deadline) throw new HetznerError(`Timed out waiting for Hetzner action ${action.id}`);
      await sleep(2000);
      current = (await this.request<{ action: HetznerAction }>("get", `/actions/${action.id}`)).action;
    }
    if (current.status === "error") {
      throw new HetznerError(`Hetzner action ${action.id} failed: ${current.error?.message ?? "unknown error"}`);
    }
  }

  get serverId(): number {
    const id = process.env.HETZNER_SERVER_ID;
    if (!id) throw new HetznerError("HETZNER_SERVER_ID is not set");
    return Number(id);
  }

  /**
   * Creates a new IPv4 Floating IP. It must be in the same location as the
   * Proxmox server (nbg1) or it can't be assigned to it.
   */
  async buyFloatingIP(label: string): Promise<{ id: number; ip: string }> {
    const { floating_ip } = await this.request<{ floating_ip: ApiFloatingIp }>("post", "/floating_ips", {
      data: {
        type: "ipv4",
        home_location: process.env.HETZNER_LOCATION || "nbg1",
        description: label,
      },
    });
    return { id: floating_ip.id, ip: floating_ip.ip };
  }

  /** Routes the Floating IP to a server and waits until Hetzner has applied it. */
  async assignFloatingIP(floatingIpId: number, serverId: number = this.serverId): Promise<void> {
    const { action } = await this.request<{ action: HetznerAction }>(
      "post",
      `/floating_ips/${floatingIpId}/actions/assign`,
      { data: { server: serverId } }
    );
    await this.waitForAction(action);
  }

  /** Deletes the Floating IP (Hetzner unassigns it automatically). Already-deleted IPs are ignored. */
  async releaseFloatingIP(floatingIpId: number): Promise<void> {
    try {
      await this.request("delete", `/floating_ips/${floatingIpId}`);
    } catch (err) {
      if (err instanceof HetznerError && err.status === 404) return;
      throw err;
    }
  }

  /** Every Floating IP in the project, across all pages. */
  async listFloatingIPs(): Promise<FloatingIp[]> {
    const all: FloatingIp[] = [];
    for (let page: number | null = 1; page !== null; ) {
      const res: { floating_ips: ApiFloatingIp[]; meta?: { pagination?: { next_page: number | null } } } =
        await this.request("get", "/floating_ips", { params: { page, per_page: 50 } });
      all.push(...res.floating_ips.map(toFloatingIp));
      page = res.meta?.pagination?.next_page ?? null;
    }
    return all;
  }
}

export const hetzner = new HetznerService();
