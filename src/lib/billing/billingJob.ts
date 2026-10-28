import { prisma } from "@/lib/prisma";
import { deprovisionVPS } from "@/lib/provisioning/provisionVPS";
import { sendBillingNoticeEmail } from "@/lib/email";
import { LIVE_STATUSES, TERMINAL_STATUSES, syncSubscription } from "./subscriptions";
import { suspendForNonPayment, BILLING_SUSPEND_REASON, DELETE_AFTER_SUSPENDED_DAYS } from "./suspension";

const DAY_MS = 24 * 60 * 60 * 1000;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://sowsicloud.com";

export type BillingJobSummary = { checked: number; extended: number; suspended: number; deleted: number; errors: string[] };

/**
 * Periodic billing sweep (run every ~15 minutes via /api/cron/billing).
 * Safe to run concurrently or repeatedly: every state change is an atomic claim.
 *
 * 1. ACTIVE services past their paid period: re-sync the autopay from
 *    Razorpay (in case a webhook was missed). Extend if it was charged, leave
 *    alone while Razorpay is still charging/retrying, otherwise suspend.
 * 2. Services suspended for non-payment for DELETE_AFTER_SUSPENDED_DAYS: delete.
 */
export async function runBillingJob(now = new Date()): Promise<BillingJobSummary> {
  const summary: BillingJobSummary = { checked: 0, extended: 0, suspended: 0, deleted: 0, errors: [] };

  const overdue = await prisma.service.findMany({
    where: { status: "ACTIVE", nextBillingDate: { lt: now } },
    include: { subscriptions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  for (const service of overdue) {
    summary.checked++;
    try {
      let sub = service.subscriptions[0];
      // Re-check anything Razorpay might still charge — a stale CREATED/HALTED row
      // may already be active there if its webhook was missed.
      if (sub && !TERMINAL_STATUSES.includes(sub.status)) {
        sub = await syncSubscription(sub.razorpaySubscriptionId);
        if (sub.currentEnd && sub.currentEnd > service.nextBillingDate) {
          // Charged, but the subscription.charged webhook hasn't been processed
          // (Razorpay retries it for 24h; that delivery records the invoice).
          await prisma.service.update({ where: { id: service.id }, data: { nextBillingDate: sub.currentEnd } });
          summary.extended++;
          continue;
        }
        // Charge is scheduled or Razorpay is retrying — the halted webhook suspends if it fails.
        if (LIVE_STATUSES.includes(sub.status)) continue;
      }
      if (await suspendForNonPayment(service.id, "its paid period ended without an active autopay")) summary.suspended++;
    } catch (err) {
      summary.errors.push(`service ${service.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const expired = await prisma.service.findMany({
    where: {
      status: "SUSPENDED",
      suspendReason: BILLING_SUSPEND_REASON,
      suspendedAt: { lt: new Date(now.getTime() - DELETE_AFTER_SUSPENDED_DAYS * DAY_MS) },
    },
    include: { user: true, plan: true },
  });

  for (const service of expired) {
    try {
      await deprovisionVPS(service.id);
      summary.deleted++;
      await prisma.notification
        .create({
          data: {
            userId: service.userId,
            title: "Server deleted",
            message: `Your ${service.plan.name} server was deleted after ${DELETE_AFTER_SUSPENDED_DAYS} days without payment.`,
          },
        })
        .catch(console.error);
      await sendBillingNoticeEmail(service.user.email, service.user.name, {
        subject: `Your ${service.plan.name} server has been deleted`,
        heading: "Server deleted",
        tone: "danger",
        paragraphs: [
          `Your <strong>${service.plan.name}</strong> server${service.hostname ? ` (${service.hostname})` : ""} was suspended for non-payment ${DELETE_AFTER_SUSPENDED_DAYS} days ago and has now been permanently deleted, including its data and IP address.`,
          "You can order a new server any time.",
        ],
        cta: { label: "View plans", url: `${APP_URL}/pricing` },
      }).catch(console.error);
    } catch (err) {
      // deprovisionVPS already alerts admins about partial teardowns.
      summary.errors.push(`delete ${service.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return summary;
}
