import { prisma } from "@/lib/prisma";
import { alertAdmins } from "@/lib/adminAlert";
import { prismaEngineLog } from "@/engine/data/engineLog";
import { resumeWaitingOrders } from "@/lib/provisioning/placement";
import { alertPaidWithoutContainer } from "@/lib/provisioning/paidWithoutContainer";
import { nodeLoads, placementConfig, planNeed } from "@/lib/provisioning/placementDeps";
import { provisioningQueue } from "./provisioningQueue";

/** A 0% order older than this was never started (e.g. the app restarted) and is picked up again. */
const NEVER_STARTED_AFTER_MS = 10 * 60_000;

/**
 * Paid VPS orders that haven't started: held for a node, or lost from the
 * in-process queue. Runs from the 15-minute cron (/api/cron/billing).
 */
export async function runProvisioningSweep(now = new Date()) {
  if (process.env.PROVISIONER !== "proxmox") return { started: 0, waiting: 0 };
  return resumeWaitingOrders(
    {
      async pendingOrders() {
        const rows = await prisma.service.findMany({
          where: {
            status: "PROVISIONING",
            provisioningPct: 0,
            plan: { category: "VPS" },
            OR: [{ waitingForNodeSince: { not: null } }, { createdAt: { lt: new Date(now.getTime() - NEVER_STARTED_AFTER_MS) } }],
          },
          include: { plan: { select: { name: true, ramGB: true, storageGB: true } }, user: { select: { name: true, email: true } } },
          orderBy: { createdAt: "asc" },
        });
        return rows.map((s) => ({
          serviceId: s.id,
          planName: s.plan.name,
          customer: `${s.user.name} <${s.user.email}>`,
          waitingSince: s.waitingForNodeSince,
          need: planNeed(s.plan),
        }));
      },
      nodes: () => nodeLoads(prisma, now.getTime()),
      config: placementConfig(),
      start: (serviceId) => provisioningQueue.add({ serviceId }),
      alertAdmin: alertAdmins,
      async lastReminderAt() {
        const row = await prisma.engineLog.findFirst({ where: { action: "PROVISION_WAITING_REMINDER" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
        return row?.createdAt ?? null;
      },
      recordReminder: (count) => prismaEngineLog({ action: "PROVISION_WAITING_REMINDER", after: { waitingOrders: count }, trigger: "SCHEDULED" }),
    },
    now
  );
}

/**
 * Paid orders with no container 10 minutes after payment — alerted once each.
 * Runs whatever PROVISIONER says: a simulated or held order is exactly what it must catch.
 */
export async function runPaidWithoutContainerCheck(now = new Date()) {
  return alertPaidWithoutContainer(
    {
      async candidates(paidBefore) {
        const rows = await prisma.service.findMany({
          where: {
            proxmoxVmId: null,
            status: { notIn: ["CANCELLED", "DELETED", "FAILED"] },
            createdAt: { lt: paidBefore },
            payments: { some: { status: "SUCCESS" } },
          },
          include: { plan: { select: { name: true } }, user: { select: { name: true, email: true } } },
          orderBy: { createdAt: "asc" },
        });
        return rows.map((s) => ({
          serviceId: s.id,
          planName: s.plan.name,
          customer: `${s.user.name} <${s.user.email}>`,
          status: s.status,
          provisioningStep: s.provisioningStep,
          paidAt: s.createdAt,
        }));
      },
      async alreadyAlerted(serviceIds) {
        const rows = await prisma.engineLog.findMany({ where: { action: "PAID_NO_CONTAINER", serviceId: { in: serviceIds } }, select: { serviceId: true } });
        return new Set(rows.map((r) => r.serviceId!));
      },
      alertAdmin: alertAdmins,
      record: (o) =>
        prismaEngineLog({ action: "PAID_NO_CONTAINER", serviceId: o.serviceId, after: { status: o.status, step: o.provisioningStep, paidAt: o.paidAt }, trigger: "SCHEDULED", success: false }),
    },
    now
  );
}
