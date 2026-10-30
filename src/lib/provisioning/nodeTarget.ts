// Everything about a node that provisioning needs, taken from its ProxmoxNode
// row — never from PROXMOX_NODE / HETZNER_SERVER_ID / PROXMOX_IPV6_SUBNET.

export type NodeTarget = {
  /** Proxmox node name (API path). */
  name: string;
  /** Public IP: Proxmox API (port 8006) and the route-sync SSH dispatcher. */
  ip: string;
  /** Hetzner server the Floating IP is routed to. */
  hetznerServerId: number;
  /** Hetzner location; a Floating IP can only be routed to a server in its home location. */
  location: string;
  /** The node's own routed /64; container IPv6 addresses come from it. */
  ipv6Subnet: string;
};

export function nodeTarget(node: { name: string; ip: string; hetznerServerId: string; location: string; ipv6Subnet: string | null }): NodeTarget {
  const hetznerServerId = Number(node.hetznerServerId);
  if (!Number.isInteger(hetznerServerId) || hetznerServerId <= 0) throw new Error(`node ${node.name} has an invalid hetznerServerId "${node.hetznerServerId}"`);
  if (!node.ipv6Subnet) throw new Error(`node ${node.name} has no ipv6Subnet`);
  return { name: node.name, ip: node.ip, hetznerServerId, location: node.location, ipv6Subnet: node.ipv6Subnet.replace(/:+$/, "") };
}

/**
 * The node holding a container. VM ids repeat across nodes (each starts at 100), so
 * a row with no node recorded can only be trusted while there is exactly one node.
 * Null = it can't be told which container that VM id means: touch nothing.
 */
export function containerNode<N>(recorded: N | null | undefined, allNodes: N[]): N | null {
  return recorded ?? (allNodes.length === 1 ? allNodes[0] : null);
}

/** "2a01:4f8:1c16:5f1d" + vmid 100 → "2a01:4f8:1c16:5f1d::100" */
export function ipv6ForVmid(subnet: string, vmid: number): string {
  // The VMID's decimal digits are used as the final hextet, which only fits up to 4 digits.
  if (vmid > 9999) throw new Error(`VMID ${vmid} doesn't fit the ::{vmid} IPv6 scheme`);
  return `${subnet.replace(/:+$/, "")}::${vmid}`;
}
