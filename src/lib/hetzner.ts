import axios, { AxiosError, type AxiosAdapter, type AxiosInstance } from "axios";

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

type ApiVolume = { id: number; name: string; size: number; assignee: { id: number; type: string } | null; location: { name: string } };

function toVolume(v: ApiVolume): HetznerVolume {
  return { id: v.id, name: v.name, sizeGB: v.size, server: v.assignee?.id ?? null, location: v.location.name };
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
  /** Its Primary IPs. Billed hourly on their own, so a delete must not leave them behind. */
  primaryIpIds: number[];
  /** The next boot goes into the rescue system. */
  rescueEnabled: boolean;
  labels: Record<string, string>;
};

type ApiServer = {
  id: number;
  name: string;
  status: string;
  server_type: { name: string };
  location: { name: string };
  public_net: { ipv4: { id?: number; ip: string } | null; ipv6: { id?: number; ip: string } | null };
  rescue_enabled?: boolean;
  labels: Record<string, string>;
};

export function toServer(s: ApiServer): HetznerServer {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    serverType: s.server_type.name,
    location: s.location.name,
    ipv4: s.public_net.ipv4?.ip ?? null,
    ipv6Network: s.public_net.ipv6?.ip ?? null,
    primaryIpIds: [s.public_net.ipv4?.id, s.public_net.ipv6?.id].filter((id): id is number => typeof id === "number"),
    rescueEnabled: Boolean(s.rescue_enabled),
    labels: s.labels ?? {},
  };
}

export type HetznerPrimaryIp = { id: number; ip: string; type: string; assigneeId: number | null; autoDelete: boolean; location: string };

type ApiPrimaryIp = { id: number; ip: string; type: string; assignee_id: number | null; auto_delete: boolean; location: { name: string } };

const toPrimaryIp = (p: ApiPrimaryIp): HetznerPrimaryIp => ({ id: p.id, ip: p.ip, type: p.type, assigneeId: p.assignee_id, autoDelete: p.auto_delete, location: p.location.name });

/** What deleting a server did about its Primary IPs. */
export type ServerDeleted = { primaryIpsRemoved: number[]; primaryIpsLeft: number[] };

export type HetznerSshKey = { id: number; name: string; fingerprint: string; publicKey: string };

/** Gross prices in EUR for one location. */
export type HetznerPrice = { hourlyEur: number; monthlyEur: number };

type ApiPrice = { location: string; price_hourly: { gross: string }; price_monthly: { gross: string } };
const toPrice = (p: ApiPrice): HetznerPrice => ({ hourlyEur: Number(p.price_hourly.gross), monthlyEur: Number(p.price_monthly.gross) });

/** One entry of GET /server_types. */
export type ApiServerType = {
  id: number;
  name: string;
  architecture: string;
  cores: number;
  memory: number;
  disk: number;
  prices: ApiPrice[];
  locations: { name: string; available: boolean; recommended: boolean; deprecation: { unavailable_after: string } | null }[];
};

export type ServerTypeOffer = { buyable: boolean; reason: string | null; price: HetznerPrice | null };

/**
 * Whether a server type can be bought in a location, and at what price: only
 * when its entry says available: true and deprecation: null. Anything missing
 * or unreadable counts as not buyable, with the reason. Never assumed.
 */
export function serverTypeOffer(type: ApiServerType, location: string): ServerTypeOffer {
  const entry = Array.isArray(type.locations) ? type.locations.find((l) => l.name === location) : undefined;
  const listed = Array.isArray(type.prices) ? type.prices.find((p) => p.location === location) : undefined;
  const price = listed ? toPrice(listed) : null;
  const refuse = (reason: string): ServerTypeOffer => ({ buyable: false, reason, price });
  if (!Array.isArray(type.locations)) return refuse(`Hetzner's answer for ${type.name} has no locations list, so availability can't be read`);
  if (!entry) return refuse(`${type.name} isn't sold in ${location}`);
  if (typeof entry.available !== "boolean" || entry.deprecation === undefined) return refuse(`Hetzner's entry for ${type.name} in ${location} has no available/deprecation fields, so availability can't be read`);
  if (entry.deprecation !== null) return refuse(`${type.name} is deprecated in ${location} (unavailable after ${entry.deprecation.unavailable_after})`);
  if (!entry.available) return refuse(`${type.name} isn't available in ${location} right now`);
  if (!price || !Number.isFinite(price.monthlyEur) || !Number.isFinite(price.hourlyEur)) return refuse(`Hetzner lists no price for ${type.name} in ${location}`);
  return { buyable: true, reason: null, price };
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

  /** `adapter`, `token` and `pollMs` are for the tests (a simulated Hetzner at the HTTP level). */
  constructor(private readonly options: { adapter?: AxiosAdapter; token?: string; pollMs?: number } = {}) {}

  private api(): AxiosInstance {
    if (this.client) return this.client;
    const token = this.options.token ?? process.env.HETZNER_API_TOKEN;
    if (!token) throw new HetznerError("HETZNER_API_TOKEN is not set");
    this.client = axios.create({
      baseURL: "https://api.hetzner.cloud/v1",
      timeout: 30_000,
      headers: { Authorization: `Bearer ${token}` },
      ...(this.options.adapter ? { adapter: this.options.adapter } : {}),
    });
    return this.client;
  }

  /** Every row of a list endpoint, across all pages (meta.pagination; Link headers are deprecated). */
  private async listAll<T>(path: string, key: string, params: Record<string, string | number> = {}): Promise<T[]> {
    const all: T[] = [];
    for (let page: number | null = 1; page !== null; ) {
      const res: Record<string, unknown> & { meta?: { pagination?: { next_page: number | null } } } = await this.request("get", path, { params: { ...params, page, per_page: 50 } });
      all.push(...((res[key] as T[]) ?? []));
      page = res.meta?.pagination?.next_page ?? null;
    }
    return all;
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
      await sleep(this.options.pollMs ?? 2000);
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
      // No automount here: Hetzner only accepts it together with a server to attach to.
      data: { name: input.name, size: input.sizeGB, location: input.location, format: "ext4", labels: input.labels },
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
      data: { assignee: { id: serverId, type: "server" }, automount: false },
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

  /**
   * Deletes a server, waits until Hetzner has, then makes sure its Primary IPs
   * went with it: an unattached Primary IPv4 keeps billing hourly. IPs created
   * with the server have auto_delete on; any left unassigned are deleted here,
   * and any that can't be are reported. An already-deleted server is ignored.
   */
  async deleteServer(serverId: number): Promise<ServerDeleted> {
    const ips = (await this.getServer(serverId))?.primaryIpIds ?? [];
    try {
      const { action } = await this.request<{ action?: HetznerAction }>("delete", `/servers/${serverId}`);
      if (action) await this.waitForAction(action, 5 * 60_000);
    } catch (err) {
      if (err instanceof HetznerError && err.status === 404) return { primaryIpsRemoved: [], primaryIpsLeft: [] };
      throw err;
    }
    const primaryIpsRemoved: number[] = [];
    const primaryIpsLeft: number[] = [];
    for (const id of ips) {
      const ip = await this.getPrimaryIP(id);
      if (!ip) continue;
      try {
        if (ip.assigneeId !== null) throw new HetznerError(`still assigned to ${ip.assigneeId}`);
        await this.deletePrimaryIP(id);
        primaryIpsRemoved.push(id);
      } catch {
        primaryIpsLeft.push(id);
      }
    }
    return { primaryIpsRemoved, primaryIpsLeft };
  }

  // ── Rescue and power ──

  /** The next boot goes into the rescue system. Hetzner turns it off again at that boot, or after 60 minutes. */
  async enableRescue(serverId: number, sshKeyIds: number[]): Promise<void> {
    // The response also has a root_password: unused, since the key logs in, and never kept.
    const { action } = await this.request<{ action: HetznerAction }>("post", `/servers/${serverId}/actions/enable_rescue`, { data: { type: "linux64", ssh_keys: sshKeyIds } });
    await this.waitForAction(action);
  }

  async disableRescue(serverId: number): Promise<void> {
    const { action } = await this.request<{ action: HetznerAction }>("post", `/servers/${serverId}/actions/disable_rescue`);
    await this.waitForAction(action);
  }

  /** Cuts power and starts the server again: a hard power cycle. */
  async resetServer(serverId: number): Promise<void> {
    const { action } = await this.request<{ action: HetznerAction }>("post", `/servers/${serverId}/actions/reset`);
    await this.waitForAction(action);
  }

  // ── Primary IPs ──

  async getPrimaryIP(id: number): Promise<HetznerPrimaryIp | null> {
    try {
      return toPrimaryIp((await this.request<{ primary_ip: ApiPrimaryIp }>("get", `/primary_ips/${id}`)).primary_ip);
    } catch (err) {
      if (err instanceof HetznerError && err.status === 404) return null;
      throw err;
    }
  }

  async listPrimaryIPs(): Promise<HetznerPrimaryIp[]> {
    return (await this.listAll<ApiPrimaryIp>("/primary_ips", "primary_ips")).map(toPrimaryIp);
  }

  /** Must be unassigned first (Hetzner: must_be_unassigned). An already-deleted IP is ignored. */
  async deletePrimaryIP(id: number): Promise<void> {
    try {
      await this.request("delete", `/primary_ips/${id}`);
    } catch (err) {
      if (err instanceof HetznerError && err.status === 404) return;
      throw err;
    }
  }

  // ── Server types and prices ──

  /** A server type with its per-location availability and prices, or null if Hetzner has no such type. */
  async getServerType(name: string): Promise<ApiServerType | null> {
    const { server_types } = await this.request<{ server_types: ApiServerType[] }>("get", "/server_types", { params: { name } });
    return server_types.find((t) => t.name === name) ?? null;
  }

  /** Gross EUR prices of a primary IPv4 and a Floating IPv4 in a location (server prices come from getServerType). */
  async ipPrices(location: string): Promise<{ primaryIpv4: HetznerPrice | null; floatingIpv4MonthlyEur: number | null }> {
    const { pricing } = await this.request<{
      pricing: {
        primary_ips: { type: string; prices: ApiPrice[] }[];
        floating_ips: { type: string; prices: { location: string; price_monthly: { gross: string } }[] }[];
      };
    }>("get", "/pricing");
    const at = <T extends { location: string }>(prices: T[] | undefined) => prices?.find((p) => p.location === location);
    const ip = at(pricing.primary_ips.find((t) => t.type === "ipv4")?.prices);
    const fip = at(pricing.floating_ips.find((t) => t.type === "ipv4")?.prices);
    return { primaryIpv4: ip ? toPrice(ip) : null, floatingIpv4MonthlyEur: fip ? Number(fip.price_monthly.gross) : null };
  }

  // ── SSH keys ──

  async listSshKeys(): Promise<HetznerSshKey[]> {
    const keys = await this.listAll<{ id: number; name: string; fingerprint: string; public_key: string }>("/ssh_keys", "ssh_keys");
    return keys.map((k) => ({ id: k.id, name: k.name, fingerprint: k.fingerprint, publicKey: k.public_key }));
  }

  async createSshKey(name: string, publicKey: string, labels: Record<string, string> = {}): Promise<HetznerSshKey> {
    const { ssh_key } = await this.request<{ ssh_key: { id: number; name: string; fingerprint: string; public_key: string } }>("post", "/ssh_keys", {
      data: { name, public_key: publicKey.trim(), labels },
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
    return (await this.listAll<ApiFloatingIp>("/floating_ips", "floating_ips")).map(toFloatingIp);
  }
}

export const hetzner = new HetznerService();
