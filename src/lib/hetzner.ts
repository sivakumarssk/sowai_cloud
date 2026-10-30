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
  /** Hetzner's error code, e.g. "resource_unavailable", "resource_limit_exceeded". */
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "HetznerError";
  }
}

/** A Hetzner Cloud server, as the node installer needs it. */
export type HetznerServer = {
  id: number;
  name: string;
  status: string;
  serverType: string;
  location: string;
  ipv4: string | null;
  /** The server's routed IPv6 network, e.g. "2a01:4f8:1c1c:abcd::/64". */
  ipv6Network: string | null;
  labels: Record<string, string>;
};

type ApiServer = {
  id: number;
  name: string;
  status: string;
  server_type: { name: string };
  datacenter: { location: { name: string } };
  public_net: { ipv4: { ip: string } | null; ipv6: { ip: string } | null };
  labels: Record<string, string>;
};

function toServer(s: ApiServer): HetznerServer {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    serverType: s.server_type.name,
    location: s.datacenter.location.name,
    ipv4: s.public_net.ipv4?.ip ?? null,
    ipv6Network: s.public_net.ipv6?.ip ?? null,
    labels: s.labels ?? {},
  };
}

export type HetznerSshKey = { id: number; name: string; fingerprint: string; publicKey: string };

/** Gross prices in EUR for one location. */
export type HetznerPrice = { hourlyEur: number; monthlyEur: number };

type ApiPrice = { location: string; price_hourly: { gross: string }; price_monthly: { gross: string } };
const toPrice = (p: ApiPrice): HetznerPrice => ({ hourlyEur: Number(p.price_hourly.gross), monthlyEur: Number(p.price_monthly.gross) });

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
    method: "get" | "post" | "put" | "delete",
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
        throw new HetznerError(`${method.toUpperCase()} ${path} failed: ${detail}`, err.response?.status, body?.error?.code);
      }
      throw err;
    }
  }

  async waitForAction(action: HetznerAction, timeoutMs = 2 * 60_000): Promise<void> {
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

  // ── Servers (Proxmox nodes; see scripts/node/install-node.ts) ──

  /**
   * Buys a server. Billed hourly from now until it is deleted. Throws a HetznerError
   * with Hetzner's code (e.g. resource_unavailable, resource_limit_exceeded) when
   * nothing was created; if the create action itself fails, the server is deleted.
   */
  async createServer(input: {
    name: string;
    serverType: string;
    location: string;
    image: string;
    sshKeyIds: number[];
    labels: Record<string, string>;
  }): Promise<HetznerServer> {
    const { server, action } = await this.request<{ server: ApiServer; action: HetznerAction }>("post", "/servers", {
      data: {
        name: input.name,
        server_type: input.serverType,
        location: input.location,
        image: input.image,
        ssh_keys: input.sshKeyIds,
        labels: input.labels,
        public_net: { enable_ipv4: true, enable_ipv6: true },
        start_after_create: true,
        // No backups: they are a separate, paid option that is never enabled here.
      },
    });
    try {
      await this.waitForAction(action, 5 * 60_000);
    } catch (err) {
      await this.deleteServer(server.id).catch(() => {});
      throw err;
    }
    return (await this.getServer(server.id)) ?? toServer(server);
  }

  async getServer(serverId: number): Promise<HetznerServer | null> {
    try {
      return toServer((await this.request<{ server: ApiServer }>("get", `/servers/${serverId}`)).server);
    } catch (err) {
      if (err instanceof HetznerError && err.status === 404) return null;
      throw err;
    }
  }

  async findServerByName(name: string): Promise<HetznerServer | null> {
    const { servers } = await this.request<{ servers: ApiServer[] }>("get", "/servers", { params: { name } });
    return servers[0] ? toServer(servers[0]) : null;
  }

  /** Deletes a server and waits until Hetzner has. An already-deleted server is ignored. */
  async deleteServer(serverId: number): Promise<void> {
    try {
      const { action } = await this.request<{ action: HetznerAction }>("delete", `/servers/${serverId}`);
      await this.waitForAction(action, 5 * 60_000);
    } catch (err) {
      if (err instanceof HetznerError && err.status === 404) return;
      throw err;
    }
  }

  /** Gross EUR prices of a server type, a primary IPv4 and a Floating IPv4 in a location. */
  async prices(serverType: string, location: string): Promise<{ server: HetznerPrice | null; primaryIpv4: HetznerPrice | null; floatingIpv4MonthlyEur: number | null }> {
    const { pricing } = await this.request<{
      pricing: {
        server_types: { name: string; prices: ApiPrice[] }[];
        primary_ips: { type: string; prices: ApiPrice[] }[];
        floating_ips: { type: string; prices: { location: string; price_monthly: { gross: string } }[] }[];
      };
    }>("get", "/pricing");
    const at = <T extends { location: string }>(prices: T[] | undefined) => prices?.find((p) => p.location === location);
    const server = at(pricing.server_types.find((t) => t.name === serverType)?.prices);
    const ip = at(pricing.primary_ips.find((t) => t.type === "ipv4")?.prices);
    const fip = at(pricing.floating_ips.find((t) => t.type === "ipv4")?.prices);
    return { server: server ? toPrice(server) : null, primaryIpv4: ip ? toPrice(ip) : null, floatingIpv4MonthlyEur: fip ? Number(fip.price_monthly.gross) : null };
  }

  /** Whether a server type can be ordered in a location right now (any of its datacenters). */
  async serverTypeAvailable(serverType: string, location: string): Promise<{ known: boolean; available: boolean }> {
    const { server_types } = await this.request<{ server_types: { id: number; name: string; deprecation: unknown }[] }>("get", "/server_types", { params: { name: serverType } });
    const type = server_types[0];
    if (!type) return { known: false, available: false };
    const { datacenters } = await this.request<{ datacenters: { location: { name: string }; server_types: { available: number[] } }[] }>("get", "/datacenters");
    return { known: true, available: datacenters.some((d) => d.location.name === location && d.server_types.available.includes(type.id)) };
  }

  async listSshKeys(): Promise<HetznerSshKey[]> {
    const { ssh_keys } = await this.request<{ ssh_keys: { id: number; name: string; fingerprint: string; public_key: string }[] }>("get", "/ssh_keys", { params: { per_page: 50 } });
    return ssh_keys.map((k) => ({ id: k.id, name: k.name, fingerprint: k.fingerprint, publicKey: k.public_key }));
  }

  async createSshKey(name: string, publicKey: string, labels: Record<string, string> = {}): Promise<HetznerSshKey> {
    const { ssh_key } = await this.request<{ ssh_key: { id: number; name: string; fingerprint: string; public_key: string } }>("post", "/ssh_keys", {
      data: { name, public_key: publicKey, labels },
    });
    return { id: ssh_key.id, name: ssh_key.name, fingerprint: ssh_key.fingerprint, publicKey: ssh_key.public_key };
  }

  async deleteSshKey(id: number): Promise<void> {
    try {
      await this.request("delete", `/ssh_keys/${id}`);
    } catch (err) {
      if (err instanceof HetznerError && err.status === 404) return;
      throw err;
    }
  }

  async getFloatingIP(floatingIpId: number): Promise<FloatingIp | null> {
    try {
      return toFloatingIp((await this.request<{ floating_ip: ApiFloatingIp }>("get", `/floating_ips/${floatingIpId}`)).floating_ip);
    } catch (err) {
      if (err instanceof HetznerError && err.status === 404) return null;
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
