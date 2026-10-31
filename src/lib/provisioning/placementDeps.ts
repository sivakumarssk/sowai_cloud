import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { alertAdmins } from "@/lib/adminAlert";
import { prismaEngineLog } from "@/engine/data/engineLog";
import type { Need, NodeLoad, PlacementConfig, PlacementDeps, PlacementTx } from "./placement";

type Db = Prisma.TransactionClient | typeof prisma;

/** Monitor figures older than this are ignored (it writes every 30 s while the engine runs). */
const MONITOR_MAX_AGE_MS = 10 * 60_000;
/** Arbitrary constant: the advisory lock id that serialises container placement. */
const PLACEMENT_LOCK = 734_401;

const IN_FLIGHT = ["PROVISIONING", "INSTALLING"] as const;
const SETTLED = ["ACTIVE", "SUSPENDED"] as const;

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.split("#")[0].trim();
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${process.env[name]}"`);
  return n;
}

/**
 * NODE_RAM_OVERCOMMIT   promised container RAM may reach physical × this [1 = none]
 * DISK_POOL_RESERVE_GB  free-pool space never handed out [20]
 * HOST_RAM_RESERVE_MB   RAM kept for Proxmox until the monitor has measured it [1536]
 */
export function placementConfig(): PlacementConfig {
  return { ramOvercommit: num("NODE_RAM_OVERCOMMIT", 1), diskPoolReserveGB: num("DISK_POOL_RESERVE_GB", 20), hostRamReserveMB: num("HOST_RAM_RESERVE_MB", 1536) };
}

const monitorFresh = (n: { lastSeenAt: Date | null }, now: number) => n.lastSeenAt !== null && now - n.lastSeenAt.getTime() < MONITOR_MAX_AGE_MS;

/** The monitor's reading of the host's own RAM, if it's recent enough to trust. */
export function measuredHostRamMB(n: { lastSeenAt: Date | null; hostUsedRamMB: number | null }, now = Date.now()): number | null {
  return monitorFresh(n, now) ? n.hostUsedRamMB : null;
}

const pool = () => (process.env.PROXMOX_STORAGE ?? "").trim() || "local";

export function planNeed(plan: { ramGB: number | null; storageGB: number | null }): Need {
  return { ramMB: (plan.ramGB ?? 0) * 1024, diskGB: plan.storageGB ?? 0 };
}

/** Every registered node with what's committed on it. */
export async function nodeLoads(db: Db, now = Date.now()): Promise<NodeLoad[]> {
  const [nodes, services] = await Promise.all([
    db.proxmoxNode.findMany({ orderBy: { name: "asc" } }),
    db.service.findMany({
      where: { nodeId: { not: null }, status: { in: [...IN_FLIGHT, ...SETTLED] } },
      select: {
        nodeId: true,
        status: true,
        allocatedRamMB: true,
        allocatedDiskGB: true,
        dataDiskGB: true,
        dataDiskStorage: true,
        plan: { select: { ramGB: true, storageGB: true } },
      },
    }),
  ]);
  return nodes.map((n) => {
    const settled = { ramMB: 0, diskGB: 0, count: 0 };
    const inFlight = { ramMB: 0, diskGB: 0, count: 0 };
    for (const s of services) {
      if (s.nodeId !== n.id) continue;
      const bucket = (IN_FLIGHT as readonly string[]).includes(s.status) ? inFlight : settled;
      const plan = planNeed(s.plan);
      bucket.ramMB += s.allocatedRamMB ?? plan.ramMB;
      // /data on the free pool takes pool space too; on a Volume it doesn't.
      bucket.diskGB += (s.allocatedDiskGB ?? plan.diskGB) + (s.dataDiskStorage === pool() ? s.dataDiskGB : 0);
      bucket.count++;
    }
    return {
      id: n.id,
      name: n.name,
      ip: n.ip,
      hetznerServerId: n.hetznerServerId,
      location: n.location,
      ipv6Subnet: n.ipv6Subnet,
      acceptNewClients: n.acceptNewClients,
      status: n.status,
      physicalRamMB: n.physicalRamMB,
      physicalDiskGB: n.physicalDiskGB,
      maxContainers: n.maxContainers,
      monitor: monitorFresh(n, now) ? { allocatedRamMB: n.allocatedRamMB, allocatedDiskGB: n.allocatedDiskGB, containerCount: n.containerCount, hostUsedRamMB: n.hostUsedRamMB } : null,
      settled,
      inFlight,
    };
  });
}

function placementTx(tx: Prisma.TransactionClient): PlacementTx {
  return {
    async order(serviceId) {
      const s = await tx.service.findUnique({ where: { id: serviceId }, select: { status: true, provisioningPct: true, plan: { select: { ramGB: true, storageGB: true } } } });
      return s && { status: s.status, provisioningPct: s.provisioningPct, need: planNeed(s.plan) };
    },
    nodes: () => nodeLoads(tx),
    async claim(serviceId, nodeId) {
      const { count } = await tx.service.updateMany({
        where: { id: serviceId, status: "PROVISIONING", provisioningPct: 0 },
        data: { provisioningPct: 10, provisioningStep: "Allocating resources...", provisionError: null, waitingForNodeSince: null, nodeId },
      });
      return count === 1;
    },
    async markWaiting(serviceId, step) {
      const { count } = await tx.service.updateMany({
        where: { id: serviceId, status: "PROVISIONING", provisioningPct: 0, waitingForNodeSince: null },
        data: { waitingForNodeSince: new Date(), provisioningStep: step },
      });
      return count === 1;
    },
  };
}

export function prismaPlacementDeps(): PlacementDeps {
  return {
    locked: (fn) =>
      prisma.$transaction(async (tx) => {
        // Held until the transaction ends: placements run one at a time across all app processes.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLACEMENT_LOCK}::bigint)`;
        return fn(placementTx(tx));
      }),

    config: placementConfig(),

    async orderInfo(serviceId) {
      const s = await prisma.service.findUniqueOrThrow({
        where: { id: serviceId },
        include: { plan: { select: { name: true } }, user: { select: { name: true, email: true } } },
      });
      return { serviceId, planName: s.plan.name, customer: `${s.user.name} <${s.user.email}>`, waitingSince: s.waitingForNodeSince };
    },

    alertAdmin: alertAdmins,

    async notifyCustomer(serviceId, message) {
      const s = await prisma.service.findUniqueOrThrow({ where: { id: serviceId }, select: { userId: true } });
      await prisma.notification.create({ data: { userId: s.userId, title: "Order queued", message } }).catch((err) => console.error("[placement] notification failed:", err));
    },

    log: (e) => prismaEngineLog({ ...e, trigger: "AUTO_ENGINE" }),
  };
}
