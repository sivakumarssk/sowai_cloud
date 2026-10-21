import { prisma } from "@/lib/prisma";
import { proxmoxForNode } from "@/lib/proxmox";
import type { EngineConfig } from "../config";
import type { ContainerTarget } from "../actions/types";
import type { RamScalerDeps } from "../actions/RamScaler";
import type { DiskExpanderDeps } from "../actions/DiskExpander";
import { currentConfig, readContainerDisks } from "../actions/lxcConfig";
import { prismaEngineLog } from "./engineLog";

/** Target for a client service (its node, container and plan sizes). */
export async function targetForService(serviceId: string): Promise<ContainerTarget> {
  const s = await prisma.service.findUniqueOrThrow({
    where: { id: serviceId },
    include: { node: true, plan: { select: { ramGB: true, storageGB: true } } },
  });
  if (!s.node || !s.proxmoxVmId) throw new Error(`service ${serviceId} has no container (node / vmid not set)`);
  return {
    node: { id: s.node.id, name: s.node.name, ip: s.node.ip },
    vmid: Number(s.proxmoxVmId),
    serviceId: s.id,
    planRamMB: (s.plan.ramGB ?? 0) * 1024,
    planDiskGB: s.plan.storageGB ?? 0,
  };
}

/**
 * Target by node + vmid. If the container belongs to a service, that service
 * (and its plan) is used; otherwise it's treated as an unmanaged test
 * container with the plan sizes given.
 */
export async function targetForContainer(opts: {
  nodeName?: string;
  vmid: number;
  planRamMB: number;
  planDiskGB: number;
}): Promise<ContainerTarget> {
  const name = opts.nodeName ?? process.env.PROXMOX_NODE;
  const node = await prisma.proxmoxNode.findFirst({ where: name ? { name } : {}, orderBy: { name: "asc" } });
  if (!node) throw new Error(`node ${name ?? "(any)"} is not registered — run npm run db:seed`);
  const service = await prisma.service.findFirst({
    where: { nodeId: node.id, proxmoxVmId: String(opts.vmid), status: { notIn: ["DELETED", "CANCELLED"] } },
    select: { id: true },
  });
  if (service) return targetForService(service.id);
  return { node: { id: node.id, name: node.name, ip: node.ip }, vmid: opts.vmid, serviceId: null, planRamMB: opts.planRamMB, planDiskGB: opts.planDiskGB };
}

export function prismaRamDeps(): RamScalerDeps {
  return {
    async readMemoryMB(t) {
      const config = await proxmoxForNode(t.node).getLXCConfig(t.vmid);
      return Number(config.memory);
    },
    writeMemoryMB: (t, mb) => proxmoxForNode(t.node).updateLXCConfig(t.vmid, { memory: mb }),
    async recordAllocation(t, mb) {
      await prisma.service.update({ where: { id: t.serviceId! }, data: { allocatedRamMB: mb, lastRamExpansionAt: new Date() } });
    },
    log: prismaEngineLog,
  };
}

export function prismaDiskDeps(config: Pick<EngineConfig, "containerStorage">): DiskExpanderDeps {
  const GB = 1024 ** 3;
  const allocated = async (node: ContainerTarget["node"], storage: string) =>
    (await proxmoxForNode(node).listStorageVolumes(storage)).reduce((sum, v) => sum + v.size, 0);

  return {
    async readDisks(t) {
      // One call gives both what runs now and what's queued for the next restart.
      const entries = await proxmoxForNode(t.node).getLXCPending(t.vmid);
      return readContainerDisks(currentConfig(entries), entries);
    },

    async poolStatus(node) {
      const [status, allocatedBytes] = await Promise.all([
        proxmoxForNode(node).getStorageStatus(config.containerStorage),
        allocated(node, config.containerStorage),
      ]);
      return { totalBytes: status.total, allocatedBytes };
    },

    async volumes(node) {
      const rows = await prisma.hetznerVolume.findMany({ where: { nodeId: node.id, status: "ACTIVE", proxmoxStorage: { not: null } } });
      return Promise.all(
        rows.map(async (v) => ({
          id: v.id,
          storage: v.proxmoxStorage!,
          sizeGB: v.sizeGB,
          allocatedGB: (await allocated(node, v.proxmoxStorage!)) / GB,
        }))
      );
    },

    async overageOptIn(t) {
      if (!t.serviceId) return false;
      const s = await prisma.service.findUniqueOrThrow({ where: { id: t.serviceId }, select: { overageOptIn: true } });
      return s.overageOptIn;
    },

    createMount: (t, key, storage, sizeGB, path) =>
      proxmoxForNode(t.node).updateLXCConfig(t.vmid, { [key]: `${storage}:${sizeGB},mp=${path},backup=1` }),

    growDisk: (t, key, size) => proxmoxForNode(t.node).resizeLXCDisk(t.vmid, key, size),

    async recordRoot(t, rootGB) {
      if (!t.serviceId) return;
      await prisma.service.update({ where: { id: t.serviceId }, data: { allocatedDiskGB: rootGB, lastDiskExpansionAt: new Date() } });
    },

    async recordData(t, d) {
      await prisma.$transaction([
        ...(t.serviceId
          ? [
              prisma.service.update({
                where: { id: t.serviceId },
                data: { dataDiskGB: d.sizeGB, dataDiskStorage: d.storage, lastDiskExpansionAt: new Date() },
              }),
            ]
          : []),
        ...(d.volumeId ? [prisma.hetznerVolume.update({ where: { id: d.volumeId }, data: { usedGB: { increment: d.addedGB } } })] : []),
      ]);
    },

    log: prismaEngineLog,
  };
}
