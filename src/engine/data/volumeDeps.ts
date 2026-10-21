import { prisma } from "@/lib/prisma";
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

export async function volumeNode(nodeName?: string): Promise<VolumeNode> {
  const name = nodeName ?? process.env.PROXMOX_NODE;
  const node = await prisma.proxmoxNode.findFirst({ where: name ? { name } : {}, orderBy: { name: "asc" } });
  if (!node) throw new Error(`node ${name ?? "(any)"} is not registered — run npm run db:seed`);
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
