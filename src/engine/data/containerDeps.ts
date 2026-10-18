import { prisma } from "@/lib/prisma";
import { proxmoxForNode } from "@/lib/proxmox";
import type { ContainerMonitorDeps, ContainerSample } from "../monitors/ContainerMonitor";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** Production dependencies: nodes and services from the database, live data from each node's Proxmox API. */
export function prismaContainerDeps(): ContainerMonitorDeps {
  return {
    listNodes: () =>
      prisma.proxmoxNode.findMany({
        where: { status: { in: ["READY", "WARNING", "CRITICAL"] } },
        select: { id: true, name: true, ip: true },
        orderBy: { name: "asc" },
      }),

    listContainers: (node) => proxmoxForNode(node).listLXC(),

    async managedContainers(node) {
      const services = await prisma.service.findMany({
        where: { nodeId: node.id, status: "ACTIVE", proxmoxVmId: { not: null } },
        select: { id: true, userId: true, proxmoxVmId: true, plan: { select: { ramGB: true, storageGB: true, vcpu: true } } },
      });
      return services.map((s) => ({
        vmid: Number(s.proxmoxVmId),
        serviceId: s.id,
        clientId: s.userId,
        planRamMB: s.plan.ramGB ? s.plan.ramGB * 1024 : null,
        planDiskGB: s.plan.storageGB,
        planVcpu: s.plan.vcpu,
      }));
    },

    async saveSamples(samples: ContainerSample[]) {
      await prisma.resourceMetric.createMany({
        data: samples.map((s) => ({
          serviceId: s.serviceId!,
          vmid: String(s.vmid),
          ramUsedMB: Math.round(s.memUsed / MB),
          ramLimitMB: Math.round(s.memLimit / MB),
          diskUsedGB: s.diskUsed / GB,
          diskLimitGB: s.diskLimit / GB,
          cpuPct: Math.round(s.cpuUsed * 1000) / 10,
          netInBytes: BigInt(Math.round(s.netIn)),
          netOutBytes: BigInt(Math.round(s.netOut)),
          recordedAt: new Date(s.at),
        })),
      });
    },
  };
}
