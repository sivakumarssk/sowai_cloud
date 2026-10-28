import { prisma } from "@/lib/prisma";
import { proxmoxForNode } from "@/lib/proxmox";
import type { ServerHealth, ServerMonitorDeps } from "../monitors/ServerMonitor";

const HEALTH_TO_STATUS: Record<ServerHealth, "READY" | "WARNING" | "CRITICAL"> = {
  healthy: "READY",
  warning: "WARNING",
  critical: "CRITICAL",
};

/** Production dependencies for the ServerMonitor. */
export function prismaServerDeps(): ServerMonitorDeps {
  return {
    async listNodes() {
      const nodes = await prisma.proxmoxNode.findMany({
        where: { status: { in: ["READY", "WARNING", "CRITICAL"] } },
        include: { volumes: { where: { status: "ACTIVE", proxmoxStorage: { not: null } } } },
        orderBy: { name: "asc" },
      });
      return nodes.map((n) => ({
        id: n.id,
        name: n.name,
        ip: n.ip,
        hetznerServerId: n.hetznerServerId,
        volumes: n.volumes.map((v) => ({ id: v.id, storage: v.proxmoxStorage!, sizeGB: v.sizeGB })),
      }));
    },

    nodeStatus: (node) => proxmoxForNode(node).getNodeStatus(),
    storageStatus: (node, storage) => proxmoxForNode(node).getStorageStatus(storage),
    storageImages: (node, storage) => proxmoxForNode(node).listStorageVolumes(storage),
    containers: (node) => proxmoxForNode(node).listLXC(),

    async saveNode(u) {
      await prisma.$transaction([
        prisma.proxmoxNode.update({
          where: { id: u.nodeId },
          data: {
            // Measured, so a newly added node needs no hand-entered specs. Placement uses these.
            ...(u.physicalRamMB > 0 && { physicalRamMB: u.physicalRamMB }),
            ...(u.physicalDiskGB > 0 && { physicalDiskGB: u.physicalDiskGB }),
            ...(u.physicalCpu > 0 && { physicalCpu: u.physicalCpu }),
            usedRamMB: u.usedRamMB,
            usedDiskGB: u.usedDiskGB,
            usedCpuPct: u.usedCpuPct,
            allocatedRamMB: u.allocatedRamMB,
            allocatedDiskGB: u.allocatedDiskGB,
            containerCount: u.containerCount,
            lastSeenAt: new Date(u.at),
          },
        }),
        // Health only moves between READY / WARNING / CRITICAL; PROVISIONING and
        // DECOMMISSIONING are set by people and left alone.
        prisma.proxmoxNode.updateMany({
          where: { id: u.nodeId, status: { in: ["READY", "WARNING", "CRITICAL"] } },
          data: { status: HEALTH_TO_STATUS[u.health] },
        }),
        ...u.volumes.map((v) => prisma.hetznerVolume.update({ where: { id: v.id }, data: { usedGB: v.usedGB } })),
      ]);
    },
  };
}
