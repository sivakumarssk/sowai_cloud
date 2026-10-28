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

export type HetznerVolume = { id: number; name: string; sizeGB: number; server: number | null; location: string };

type ApiVolume = { id: number; name: string; size: number; server: number | null; location: { name: string } };

function toVolume(v: ApiVolume): HetznerVolume {
  return { id: v.id, name: v.name, sizeGB: v.size, server: v.server, location: v.location.name };
}

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
  /** Buys an IPv4 Floating IP whose home is `location` (it can only be routed to servers there). */
  async buyFloatingIP(label: string, location: string = process.env.HETZNER_LOCATION || "nbg1"): Promise<{ id: number; ip: string }> {
    const { floating_ip } = await this.request<{ floating_ip: ApiFloatingIp }>("post", "/floating_ips", {
      data: {
        type: "ipv4",
        home_location: location,
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

  /**
   * Unassigns the Floating IP if needed, then deletes it. Hetzner refuses to
   * delete an assigned IP ("must_be_unassigned"). Already-deleted IPs are ignored.
   */
  async releaseFloatingIP(floatingIpId: number): Promise<void> {
    try {
      const { floating_ip } = await this.request<{ floating_ip: ApiFloatingIp }>(
        "get",
        `/floating_ips/${floatingIpId}`
      );
      if (floating_ip.server !== null) {
        const { action } = await this.request<{ action: HetznerAction }>(
          "post",
          `/floating_ips/${floatingIpId}/actions/unassign`
        );
        await this.waitForAction(action);
      }
      await this.request("delete", `/floating_ips/${floatingIpId}`);
    } catch (err) {
      if (err instanceof HetznerError && err.status === 404) return;
      throw err;
    }
  }

  // ── Volumes (extra disk for a Proxmox node) ──
  // Billed by Hetzner from creation until deletion. Created ext4-formatted and
  // NOT auto-mounted: the node mounts it via sowsi-host (see proxmox-host-setup.sh).

  async createVolume(input: { name: string; sizeGB: number; location: string; labels?: Record<string, string> }): Promise<HetznerVolume> {
    const { volume, action } = await this.request<{ volume: ApiVolume; action: HetznerAction }>("post", "/volumes", {
      data: { name: input.name, size: input.sizeGB, location: input.location, format: "ext4", automount: false, labels: input.labels },
    });
    await this.waitForAction(action);
    return toVolume(volume);
  }

  async getVolume(volumeId: number): Promise<HetznerVolume | null> {
    try {
      return toVolume((await this.request<{ volume: ApiVolume }>("get", `/volumes/${volumeId}`)).volume);
    } catch (err) {
      if (err instanceof HetznerError && err.status === 404) return null;
      throw err;
    }
  }

  async attachVolume(volumeId: number, serverId: number = this.serverId): Promise<void> {
    const { action } = await this.request<{ action: HetznerAction }>("post", `/volumes/${volumeId}/actions/attach`, {
      data: { server: serverId, automount: false },
    });
    await this.waitForAction(action);
  }

  async detachVolume(volumeId: number): Promise<void> {
    const volume = await this.getVolume(volumeId);
    if (!volume || volume.server === null) return;
    const { action } = await this.request<{ action: HetznerAction }>("post", `/volumes/${volumeId}/actions/detach`);
    await this.waitForAction(action);
  }

  /** Detaches if needed, then deletes. An already-deleted volume is ignored. */
  async deleteVolume(volumeId: number): Promise<void> {
    await this.detachVolume(volumeId);
    try {
      await this.request("delete", `/volumes/${volumeId}`);
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
