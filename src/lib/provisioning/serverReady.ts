// The one rule for "this service is a real, working server".
//
// ACTIVE requires a passed SSH login check plus, for a Proxmox server, the
// container (vmid), the node it runs on and either its Floating IP or shared mode
// with its private address, name and route key — or, for a manual server an admin
// assigned, its IP. The database enforces it with the CHECK constraint
// "Service_active_requires_real_server" (migration 20261112090000_shared_mode);
// this file mirrors it for reads.

export const ACTIVE_CONSTRAINT = "Service_active_requires_real_server";

export type RealServerFields = {
  status: string;
  serverSource: string;
  serverIp: string | null;
  proxmoxVmId: string | null;
  nodeId: string | null;
  hetznerFloatingIpId: string | null;
  ipv4Mode: string;
  privateIpv4: string | null;
  /** Shared mode: its name under c.sowsicloud.com and its gateway key. */
  publicName: string | null;
  routeKey: string | null;
  sshVerifiedAt: Date | string | null;
};

/** Its IPv4: its own Floating IP, or shared mode with its private address, name and route key. */
const hasIpv4 = (s: Pick<RealServerFields, "hetznerFloatingIpId" | "ipv4Mode" | "privateIpv4" | "publicName" | "routeKey">) =>
  Boolean(s.hetznerFloatingIpId) || (s.ipv4Mode === "SHARED" && Boolean(s.privateIpv4 && s.publicName && s.routeKey));

/** What shared mode still lacks, named. */
const sharedMissing = (s: Pick<RealServerFields, "privateIpv4" | "publicName" | "routeKey">) =>
  [!s.privateIpv4 && "private IPv4", !s.publicName && "service name", !s.routeKey && "route key"].filter((x): x is string => Boolean(x)).join(", ");

/** What a service still lacks to be a real server (empty = it is one). */
export function missingForActive(s: Omit<RealServerFields, "status">): string[] {
  if (s.serverSource === "MANUAL") return [!s.serverIp && "server IP", !s.sshVerifiedAt && "SSH check"].filter((x): x is string => Boolean(x));
  return [
    !s.proxmoxVmId && "container (VM id)",
    !s.nodeId && "node",
    !hasIpv4(s) && (s.ipv4Mode === "SHARED" ? sharedMissing(s) : "Floating IP"),
    !s.sshVerifiedAt && "SSH check",
  ].filter((x): x is string => Boolean(x));
}

/** A running (or suspended) real server: the only kind whose IP and credentials are shown. */
export function isRealServer(s: RealServerFields): boolean {
  return (s.status === "ACTIVE" || s.status === "SUSPENDED") && missingForActive(s).length === 0;
}

/** Prisma filter for services that may be (re)activated. */
export const realServerWhere = {
  OR: [
    { serverSource: "PROXMOX" as const, proxmoxVmId: { not: null }, nodeId: { not: null }, hetznerFloatingIpId: { not: null }, sshVerifiedAt: { not: null } },
    { serverSource: "PROXMOX" as const, proxmoxVmId: { not: null }, nodeId: { not: null }, ipv4Mode: "SHARED" as const, privateIpv4: { not: null }, publicName: { not: null }, routeKey: { not: null }, sshVerifiedAt: { not: null } },
    { serverSource: "MANUAL" as const, serverIp: { not: null }, sshVerifiedAt: { not: null } },
  ],
};

type Credentials = {
  serverIp: string | null;
  ipv6Address: string | null;
  sshUsername: string | null;
  sshPassword: string | null;
  panelUrl: string | null;
  panelPassword: string | null;
};

/**
 * What a customer may see. Anything that isn't a real server shows as
 * "Setting up": no IP, no credentials, no panel link.
 */
export function forCustomer<T extends RealServerFields & Credentials>(s: T): T & { ready: boolean } {
  const ready = isRealServer(s);
  if (ready) return { ...s, ready };
  return {
    ...s,
    serverIp: null,
    ipv6Address: null,
    sshUsername: null,
    sshPassword: null,
    panelUrl: null,
    panelPassword: null,
    // An ACTIVE row without a real server can't be written any more (DB constraint), but never show one as running.
    status: s.status === "ACTIVE" ? "INSTALLING" : s.status,
    ready,
  };
}

/** True when a Prisma error is this constraint refusing an ACTIVE without a real server. */
export function isActiveConstraintError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${JSON.stringify((err as { meta?: unknown }).meta ?? "")}` : String(err);
  return text.includes(ACTIVE_CONSTRAINT);
}
