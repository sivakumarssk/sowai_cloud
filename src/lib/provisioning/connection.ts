// How a customer reaches their server: the one place that words it (Stage C of the shared IPv4
// gateway). The dashboard, the progress page, the ready email, the status APIs and the admin list
// all use serviceConnection(), so a Shared or Dedicated label can't say different things in
// different places.
//
// Dedicated: the service's own Floating IP, in and out, every port.
// Shared: the node gateway's IPv4 carries websites on ports 80 and 443 (routed by name); SSH and
// everything else is over the service's own IPv6.
//
// No imports from the server side: client components may use it too.

/** The zone service names live in. Mirrors SERVICE_ZONE in publicName.ts (kept here so this file stays import-free). */
const ZONE = "c.sowsicloud.com";

/**
 * Stage D creates the DNS records for service names. Until then a name isn't in DNS, so it's
 * never offered as an address to connect to.
 */
export const SERVICE_DNS_LIVE = false;

export type ConnectionFields = {
  serverSource: string;
  ipv4Mode: string;
  /** Dedicated: the service's own IPv4. Null in shared mode. */
  serverIp: string | null;
  ipv6Address: string | null;
  publicName?: string | null;
  sshUsername?: string | null;
  /** A manual server's SSH port, when it isn't 22. */
  sshPort?: number;
  /** The node's gateway address: the shared IPv4. */
  node?: { gatewayIpv4: string | null } | null;
};

export type ServiceConnection = {
  mode: "DEDICATED" | "SHARED";
  /** For lists and badges. */
  tag: "Dedicated" | "Shared";
  /** "Dedicated IPv4" or "Shared IPv4". */
  label: string;
  ipv4: string | null;
  /** What the IPv4 address does for this server. */
  ipv4Note: string;
  ipv6: string | null;
  /** The service's name under c.sowsicloud.com, once it's in DNS (Stage D). */
  hostname: string | null;
  sshCommand: string | null;
  /** What a shared server can't do over IPv4. Null for a dedicated one. */
  notice: string | null;
};

export const SHARED_NOTICE =
  "This server shares its IPv4 address with other websites, so IPv4 reaches it on ports 80 and 443 (websites) only. " +
  "SSH and every other port work over IPv6: from a network without IPv6, SSH can't reach it.";

/** A manual server or a Floating IP is always Dedicated. */
export function serviceConnection(s: ConnectionFields): ServiceConnection {
  const shared = s.serverSource !== "MANUAL" && s.ipv4Mode === "SHARED";
  const ipv6 = s.ipv6Address || null;
  if (!shared) {
    const ipv4 = s.serverIp || null;
    const host = ipv4 ?? ipv6;
    return {
      mode: "DEDICATED",
      tag: "Dedicated",
      label: "Dedicated IPv4",
      ipv4,
      ipv4Note: "Yours alone",
      ipv6,
      hostname: null,
      sshCommand: host && s.sshUsername ? `ssh ${s.sshPort && s.sshPort !== 22 ? `-p ${s.sshPort} ` : ""}${s.sshUsername}@${host}` : null,
      notice: null,
    };
  }
  const hostname = SERVICE_DNS_LIVE && s.publicName ? `${s.publicName}.${ZONE}` : null;
  const sshHost = hostname ?? ipv6;
  return {
    mode: "SHARED",
    tag: "Shared",
    label: "Shared IPv4",
    ipv4: s.node?.gatewayIpv4 || null,
    ipv4Note: "Shared with other websites: ports 80 and 443 only",
    ipv6,
    hostname,
    sshCommand: sshHost && s.sshUsername ? `ssh ${s.sshUsername}@${sshHost}` : null,
    notice: SHARED_NOTICE,
  };
}
