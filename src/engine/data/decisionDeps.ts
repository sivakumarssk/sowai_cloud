import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { alertAdmins } from "@/lib/adminAlert";
import { sendBillingNoticeEmail } from "@/lib/email";
import type { EngineConfig } from "../config";
import { loadEngineSettings, type EngineSettings } from "../core/policy";
import type { ClientNoticeTemplate, DecisionPayload } from "../core/decisions";
import { ActionExecutor, type ApprovalRecord, type ApprovalStore } from "../core/ActionExecutor";
import { DecisionMaker, type NodeState } from "../core/DecisionMaker";
import { buildHandlers } from "../core/handlers";
import { RamScaler } from "../actions/RamScaler";
import { DiskExpander } from "../actions/DiskExpander";
import { VolumeManager } from "../actions/VolumeManager";
import { prismaDiskDeps, prismaRamDeps, targetForService } from "./actionDeps";
import { prismaVolumeDeps, volumeNode } from "./volumeDeps";
import { prismaEngineLog } from "./engineLog";
import { spentThisMonthPaise } from "./spend";

/** Node RAM figures older than this are treated as unknown (the ServerMonitor writes them every 30 s). */
const NODE_STATE_MAX_AGE_MS = 10 * 60_000;

type StoredPayload = { decision: DecisionPayload; overCapAtRequest: boolean };

export function prismaApprovalStore(): ApprovalStore {
  return {
    async findOpen(kind, subject) {
      return prisma.engineApproval.findFirst({
        where: {
          kind,
          subject,
          OR: [
            { status: "PENDING", expiresAt: { gt: new Date() } },
            { status: "APPROVED", executedAt: null },
          ],
        },
        select: { id: true },
      });
    },

    async create({ decision, expiresAt, overCap }) {
      const payload: StoredPayload = { decision: decision.payload, overCapAtRequest: overCap };
      return prisma.engineApproval.create({
        data: {
          kind: decision.kind,
          subject: decision.subject,
          summary: decision.summary,
          reason: decision.reason,
          payload: payload as unknown as Prisma.InputJsonValue,
          monthlyCostPaise: decision.monthlyCostPaise,
          expiresAt,
        },
        select: { id: true },
      });
    },

    async expireDue(now) {
      const due = await prisma.engineApproval.findMany({ where: { status: "PENDING", expiresAt: { lte: now } }, select: { id: true, summary: true } });
      if (due.length) await prisma.engineApproval.updateMany({ where: { id: { in: due.map((d) => d.id) }, status: "PENDING" }, data: { status: "EXPIRED" } });
      return due;
    },

    async claimApproved() {
      const rows = await prisma.engineApproval.findMany({ where: { status: "APPROVED", executedAt: null }, orderBy: { decidedAt: "asc" } });
      const claimed: ApprovalRecord[] = [];
      for (const row of rows) {
        // Only one runner wins the claim.
        const { count } = await prisma.engineApproval.updateMany({ where: { id: row.id, status: "APPROVED", executedAt: null }, data: { executedAt: new Date() } });
        if (count !== 1) continue;
        const stored = row.payload as unknown as StoredPayload;
        claimed.push({
          id: row.id,
          kind: row.kind,
          subject: row.subject,
          summary: row.summary,
          payload: stored.decision,
          monthlyCostPaise: row.monthlyCostPaise,
          overCapAtRequest: stored.overCapAtRequest,
          decidedBy: row.decidedBy,
        });
      }
      return claimed;
    },

    async finish(id, status, result) {
      await prisma.engineApproval.update({ where: { id }, data: { status, result: result.slice(0, 2000) } });
    },
  };
}

export async function nodeState(nodeId: string): Promise<NodeState | null> {
  const n = await prisma.proxmoxNode.findUnique({ where: { id: nodeId } });
  if (!n) return null;
  const fresh = n.lastSeenAt && Date.now() - n.lastSeenAt.getTime() < NODE_STATE_MAX_AGE_MS && n.physicalRamMB > 0;
  return {
    name: n.name,
    ramPct: fresh ? Math.round((n.usedRamMB / n.physicalRamMB) * 1000) / 10 : null,
    acceptNewClients: n.acceptNewClients,
    monthlyCostPaise: n.monthlyCost,
  };
}

const APP_URL = () => process.env.NEXT_PUBLIC_APP_URL || "https://sowsicloud.com";

const NOTICES: Record<ClientNoticeTemplate, (host: string, detail: string) => Parameters<typeof sendBillingNoticeEmail>[2]> = {
  STORAGE_ALMOST_FULL: (host, detail) => ({
    subject: `Your server ${host} is running out of disk space`,
    heading: "Disk space is running low",
    paragraphs: [`Your server <b>${host}</b> has used ${detail}.`, "Free up space, upgrade your plan, or enable extra storage (billed per GB) from your dashboard."],
    tone: "warning",
    cta: { label: "Manage storage", url: `${APP_URL()}/dashboard/services` },
  }),
  STORAGE_FULL: (host, detail) => ({
    subject: `Your server ${host} is out of disk space`,
    heading: "Disk is full",
    paragraphs: [`Your server <b>${host}</b> has used ${detail}. Applications may stop writing data.`, "Free up space, upgrade your plan, or enable extra storage (billed per GB) from your dashboard."],
    tone: "danger",
    cta: { label: "Manage storage", url: `${APP_URL()}/dashboard/services` },
  }),
  UPGRADE_RAM: (host, detail) => ({
    subject: `Your server ${host} needs more memory`,
    heading: "Memory is running out",
    paragraphs: [`Your server <b>${host}</b> keeps using almost all of its memory (${detail}).`, "Upgrading to a larger plan gives it more RAM and keeps it responsive."],
    tone: "warning",
    cta: { label: "Upgrade plan", url: `${APP_URL()}/dashboard/services` },
  }),
};

export async function notifyClient(serviceId: string, template: ClientNoticeTemplate, detail: string): Promise<void> {
  const s = await prisma.service.findUniqueOrThrow({ where: { id: serviceId }, include: { user: { select: { email: true, name: true } }, plan: { select: { name: true } } } });
  const host = s.hostname ?? s.serverIp ?? s.plan.name;
  await sendBillingNoticeEmail(s.user.email, s.user.name, NOTICES[template](host, detail.replace(/[<>&]/g, "")));
}

export async function stopSignups(nodeName: string): Promise<boolean> {
  const { count } = await prisma.proxmoxNode.updateMany({ where: { name: nodeName, acceptNewClients: true }, data: { acceptNewClients: false } });
  return count === 1;
}

export const approveHint = (id: string) =>
  [
    "Approve or deny on sowsi-mgmt-01:",
    `  npx tsx scripts/engine/approvals.ts approve ${id} --by <your name>`,
    `  npx tsx scripts/engine/approvals.ts deny ${id} --by <your name>`,
  ].join("\n");

/** The production engine: DecisionMaker → ActionExecutor with Prisma, Proxmox, Hetzner and email behind it. */
export function buildDecisionEngine(config: EngineConfig, settings: () => EngineSettings = () => loadEngineSettings()) {
  const ramScaler = new RamScaler(prismaRamDeps(), config);
  const diskExpander = new DiskExpander(prismaDiskDeps(config), config);
  const volumeManager = new VolumeManager(prismaVolumeDeps(), {
    volumeCostPerGbPaise: config.volumeCostPerGbPaise,
    defaultSizeGB: config.volumeSizeGB,
    spendCapPaise: settings().spendCapPaise,
  });

  const executor = new ActionExecutor({
    settings,
    spentThisMonthPaise: () => spentThisMonthPaise(),
    handlers: buildHandlers({
      target: targetForService,
      ramScaler,
      diskExpander,
      volumeManager,
      volumeNode,
      notifyClient,
      alertAdmin: alertAdmins,
      stopSignups,
    }),
    approvals: prismaApprovalStore(),
    alertAdmin: alertAdmins,
    log: prismaEngineLog,
    approveHint,
  });

  const decisionMaker = new DecisionMaker(
    { nodeState, target: targetForService, ramScaler, diskExpander, submit: (d) => executor.handle(d) },
    config
  );
  return { executor, decisionMaker, volumeManager };
}
