import { prisma } from "@/lib/prisma";
import { alertAdmins } from "@/lib/adminAlert";
import { prismaEngineLog } from "@/engine/data/engineLog";
import { reportUnknownWebhook, UNKNOWN_WEBHOOK_ACTION, type UnknownWebhook } from "./unknownWebhook";

/** Logs to EngineLog (WEBHOOK_UNKNOWN) and emails admins, once per delivery. Never throws. */
export function reportUnknown(u: UnknownWebhook) {
  return reportUnknownWebhook(
    {
      async alreadyReported(key) {
        const row = await prisma.engineLog.findFirst({ where: { action: UNKNOWN_WEBHOOK_ACTION, after: { path: ["key"], equals: key } }, select: { id: true } });
        return row !== null;
      },
      log: (key, w) => prismaEngineLog({ action: UNKNOWN_WEBHOOK_ACTION, after: { key, ...w }, trigger: "WEBHOOK", success: false, error: `unknown ${w.kind}` }),
      alertAdmin: alertAdmins,
    },
    u
  );
}

/**
 * Why payment.captured found nothing to fulfil: no Payment row for the Razorpay
 * order ("order"), or one without its Order ("payment"). Null = it is known
 * (already fulfilled or in some other state) — not an unknown-entity webhook.
 */
export async function unknownCheckout(razorpayOrderId: string): Promise<"order" | "payment" | null> {
  const payment = await prisma.payment.findFirst({ where: { razorpayOrderId }, select: { orderId: true } });
  if (!payment) return "order";
  return payment.orderId ? null : "payment";
}
