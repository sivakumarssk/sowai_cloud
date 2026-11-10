import { prisma } from "@/lib/prisma";
import { inService, isRetired } from "@/lib/provisioning/nodeTarget";
import { hetzner } from "@/lib/hetzner";
import { proxmoxForNode } from "@/lib/proxmox";
import type { VolumeManagerDeps, VolumeNode } from "../actions/VolumeManager";
import { prismaEngineLog } from "./engineLog";
import { runOnHost } from "./hostShell";
import { spentThisMonthPaise } from "./spend";

/** "OK storage=sowsi-vol-777 path=/mnt/sowsi-vol-777" → { storage, path } */
export function parseMountOutput(output: string): { storage: string; path: string } {
  const line = output.split("\n").find((l) => l.startsWith("OK "));
  const storage = line?.match(/storage=(\S+)/)?.[1];
  const path = line?.match(/path=(\S+)/)?.[1];
  if (!storage || !path) throw new Error(`unexpected mount-volume output: ${output.trim() || "(empty)"}`);
  return { storage, path };
}

/** The named node, or the only one in service. Never a retired node, and never a guess among several. */
export async function volumeNode(nodeName?: string): Promise<VolumeNode> {
  const all = await prisma.proxmoxNode.findMany({ orderBy: { name: "asc" } });
  const live = inService(all);
  if (!nodeName && live.length > 1) throw new Error(`${live.length} nodes are in service (${live.map((n) => n.name).join(", ")}) — pass --node <name>`);
  const node = nodeName ? all.find((n) => n.name === nodeName) : live[0];
  if (!node) throw new Error(nodeName ? `node ${nodeName} is not registered` : "no node is in service — register one with scripts/node/install-node.ts");
  if (isRetired(node)) throw new Error(`node ${node.name} is retired (${node.status}) — no volume is bought for or attached to it`);
  return { id: node.id, name: node.name, ip: node.ip, hetznerServerId: node.hetznerServerId, location: node.location };
}

export function prismaVolumeDeps(): VolumeManagerDeps {
  return {
    createVolume: (input) => hetzner.createVolume(input),
    attachVolume: (id, serverId) => hetzner.attachVolume(id, serverId),
    deleteVolume: (id) => hetzner.deleteVolume(id),
    mountOnHost: async (node, id) => parseMountOutput(await runOnHost(node, `mount-volume ${id}`)),
    unmountOnHost: async (node, id) => void (await runOnHost(node, `unmount-volume ${id}`)),
    disksOnStorage: async (node, storage) => (await proxmoxForNode(node).listStorageVolumes(storage)).map((v) => v.volid),
    insertVolume: async (row) => (await prisma.hetznerVolume.create({ data: { ...row, mountPath: "" } })).id,
    updateVolume: async (id, data) => void (await prisma.hetznerVolume.update({ where: { id }, data })),
    spentThisMonthPaise: () => spentThisMonthPaise(),
    log: prismaEngineLog,
  };
}
