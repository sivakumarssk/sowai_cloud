import { connectWithRetry, provisioningKey, run } from "@/lib/vmSetup";

/**
 * Runs a command on a Proxmox node as root with the provisioning key. The key
 * is forced to /usr/local/sbin/sowsi-host on the node, which only accepts
 * `routes`, `mount-volume <id>` and `unmount-volume <id>` (see
 * scripts/proxmox-host-setup.sh) — anything else is refused there.
 */
export async function runOnHost(node: { name: string; ip: string }, command: string, timeoutMs = 3 * 60_000): Promise<string> {
  const ssh = await connectWithRetry({ host: node.ip, username: "root", ...provisioningKey() }, 3);
  try {
    return (await run(ssh, `${command} on ${node.name}`, command, { timeoutMs })).trim();
  } finally {
    ssh.dispose();
  }
}
