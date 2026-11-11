// The shared IPv4 gateway on each node (Stage B): HAProxy in container 9000, on a Floating IP of
// its own. It's ours, not a customer's: it never counts towards a node's container limit.

/** Fixed, far above Proxmox's next free id (which starts at 100), and the same on every node. */
export const GATEWAY_VMID = 9000;
export const GATEWAY_HOSTNAME = "sowsi-gateway";
/** Its size. RAM in use is measured by `sowsi-gateway status` (memory_mb). */
export const GATEWAY_SIZE = { cores: 1, memory: 512, diskSize: 4 } as const;

/** Container 9000 named sowsi-gateway: both, so a customer container can never be taken for it. */
export function isGatewayContainer(c: { vmid: number | string; name?: string | null }): boolean {
  return Number(c.vmid) === GATEWAY_VMID && c.name === GATEWAY_HOSTNAME;
}
