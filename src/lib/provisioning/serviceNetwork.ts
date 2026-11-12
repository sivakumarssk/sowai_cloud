// A new container's IPv4, dedicated or shared (Stage C of the shared IPv4 gateway).
//
// Dedicated (every customer order until Stage G): buy a Floating IP in the node's location, save
// it at once so it can be released even after a crash, and route it to the node's server. The
// container sends and receives on it, and setup logs in over it.
//
// Shared: no Floating IP. The container gets its private address (100.64.0.0/10, out by NAT, in
// through the node's gateway on 80 and 443), a name under c.sowsicloud.com and a route key. Setup
// logs in over its IPv6, as step 4 of the installer does with its test containers.
import type { SharedIdentity } from "./publicName";

export type Ipv4Mode = "DEDICATED" | "SHARED";

export type NetworkNode = { name: string; location: string; hetznerServerId: number; sharedIpv4: boolean };

export type Ipv4Plan =
  | { mode: "DEDICATED"; ipv4: string; floatingIpId: number }
  | ({ mode: "SHARED"; ipv4: string } & SharedIdentity);

export type NetworkDeps = {
  buyFloatingIP(name: string, location: string): Promise<{ id: number; ip: string }>;
  /** Saved on the service straight after the purchase. */
  saveFloatingIP(serviceId: string, ip: { id: number; ip: string }): Promise<void>;
  assignFloatingIP(id: number, serverId: number): Promise<void>;
  assignPrivateIpv4(serviceId: string): Promise<string>;
  assignSharedIdentity(serviceId: string, hint: string | null): Promise<SharedIdentity>;
  progress(step: string, pct: number): Promise<void>;
};

/**
 * Why this order can't be built in shared mode, or null. Checked before anything is bought or
 * assigned. Coolify plans keep a dedicated IPv4 until a panel URL through the gateway is proven.
 */
export function sharedRefusal(input: { mode: string; node: Pick<NetworkNode, "name" | "sharedIpv4">; hasCoolify: boolean }): string | null {
  if (input.mode !== "SHARED") return null;
  if (!input.node.sharedIpv4) return `${input.node.name} doesn't take shared-IPv4 services (its flag is off, or it has no gateway)`;
  if (input.hasCoolify) return "a Coolify server keeps a dedicated IPv4: its panel isn't reachable through the shared gateway yet";
  return null;
}

/**
 * Gets the container its IPv4. `onFloatingIp` is called as soon as a Floating IP exists, before
 * anything else can fail, so the caller can release it.
 */
export async function prepareIpv4(
  deps: NetworkDeps,
  input: { serviceId: string; mode: string; node: NetworkNode; hasCoolify: boolean; hostname: string | null; onFloatingIp: (id: number) => void }
): Promise<Ipv4Plan> {
  const refused = sharedRefusal(input);
  if (refused) throw new Error(`shared IPv4 refused: ${refused}`);
  if (input.mode === "SHARED") {
    await deps.progress("Assigning a private address...", 20);
    const ipv4 = await deps.assignPrivateIpv4(input.serviceId);
    const identity = await deps.assignSharedIdentity(input.serviceId, input.hostname);
    return { mode: "SHARED", ipv4, ...identity };
  }
  if (input.mode !== "DEDICATED") throw new Error(`unknown IPv4 mode "${input.mode}"`);
  const ip = await deps.buyFloatingIP(`sowsi-${input.serviceId}`, input.node.location);
  input.onFloatingIp(ip.id);
  await deps.saveFloatingIP(input.serviceId, ip);
  await deps.progress("Assigning IP address...", 20);
  await deps.assignFloatingIP(ip.id, input.node.hetznerServerId);
  return { mode: "DEDICATED", ipv4: ip.ip, floatingIpId: ip.id };
}

/** Where setup logs in: the Floating IP, or the container's own IPv6 in shared mode. */
export function setupAddress(plan: Ipv4Plan, ipv6: string): string {
  if (plan.mode === "DEDICATED") return plan.ipv4;
  if (!ipv6) throw new Error("a shared-mode container is set up over IPv6, and it has none");
  return ipv6;
}
