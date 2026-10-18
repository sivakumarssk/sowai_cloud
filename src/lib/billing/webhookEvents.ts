import { Prisma, type Subscription } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateInvoiceNumber } from "@/lib/razorpay";
import { sendInvoiceEmail, sendBillingNoticeEmail } from "@/lib/email";
import { alertAdmins } from "@/lib/adminAlert";
import { fulfillSubscriptionPayment } from "@/lib/fulfillPayment";
import {
  applyRazorpayState,
  findFirstPaidPaymentId,
  syncSubscription,
  TERMINAL_STATUSES,
  type RzpSubscription,
} from "./subscriptions";
import { suspendForNonPayment, resumeAfterPayment } from "./suspension";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://sowsicloud.com";
const formatDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

export const SUBSCRIPTION_EVENTS = new Set([
  "subscription.authenticated",
  "subscription.activated",
  "subscription.charged",
  "subscription.pending",
  "subscription.halted",
  "subscription.cancelled",
  "subscription.completed",
  "subscription.paused",
  "subscription.resumed",
]);

type PaymentEntity = { id: string; amount: number; status: string };
type Payload = {
  subscription?: { entity: RzpSubscription };
  payment?: { entity: PaymentEntity };
};

/**
 * Handles one Razorpay subscription webhook. Razorpay can deliver events out
 * of order and more than once, so state is re-fetched from Razorpay and every
 * side effect is idempotent.
 */
export async function handleSubscriptionEvent(event: string, payload: Payload): Promise<void> {
  const entity = payload.subscription?.entity;
  if (!entity?.id) return;

  const before = await prisma.subscription.findUnique({ where: { razorpaySubscriptionId: entity.id } });
  if (!before) {
    console.warn(`[webhook] ${event} for unknown subscription ${entity.id} — ignored`);
    return;
  }

  let sub: Subscription;
  try {
    sub = await syncSubscription(entity.id);
  } catch (err) {
    console.error(`[webhook] fetching ${entity.id} from Razorpay failed, using payload state:`, err);
    sub = await applyRazorpayState(entity);
  }

  // Only the newest subscription of a service drives its lifecycle; an old one
  // replaced by "restart autopay" must not suspend or notify.
  const latest = sub.serviceId
    ? await prisma.subscription.findFirst({ where: { serviceId: sub.serviceId }, orderBy: { createdAt: "desc" } })
    : sub;
  const isCurrent = latest?.id === sub.id;

  switch (event) {
    case "subscription.authenticated":
    case "subscription.activated":
      // Prepaid (1/2-year) orders pay their intro term at authorisation and get
      // no subscription.charged until it ends — fulfil from the paid invoice if
      // the checkout callback never reached us.
      if (!sub.serviceId && sub.orderId) {
        const paymentId = await findFirstPaidPaymentId(sub.razorpaySubscriptionId);
        if (paymentId) await fulfillSubscriptionPayment(sub.razorpaySubscriptionId, paymentId);
      }
      break;

    case "subscription.charged":
      if (payload.payment?.entity) await handleCharged(sub, payload.payment.entity);
      break;

    case "subscription.pending":
      if (isCurrent && before.status !== "PENDING") await notifyRetrying(sub);
      break;

    case "subscription.halted":
      if (isCurrent && sub.serviceId) {
        await suspendForNonPayment(sub.serviceId, "your autopay payment failed after several retries");
      }
      break;

    case "subscription.cancelled":
    case "subscription.completed":
      // Cancellations we made ourselves were already recorded (status CANCELLED) before this arrived.
      if (isCurrent && !TERMINAL_STATUSES.includes(before.status)) await notifyAutopayEnded(sub, event);
      break;
  }
}

async function handleCharged(sub: Subscription, payment: PaymentEntity) {
  if (!sub.serviceId) {
    // First charge of a checkout subscription — normally already fulfilled by
    // the verify route; this is the backup when the customer closed the tab.
    if (sub.orderId) await fulfillSubscriptionPayment(sub.razorpaySubscriptionId, payment.id);
  } else {
    await recordRenewal(sub, payment);
  }

  const fresh = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
  if (!fresh.serviceId) return;

  // The paid period now runs to the subscription's current period end.
  if (fresh.currentEnd) {
    await prisma.service.updateMany({
      where: { id: fresh.serviceId, nextBillingDate: { lt: fresh.currentEnd } },
      data: { nextBillingDate: fresh.currentEnd },
    });
  }

  const service = await prisma.service.findUniqueOrThrow({ where: { id: fresh.serviceId } });
  if (service.status === "DELETED" || service.status === "CANCELLED") {
    await alertAdmins(
      `Charged for a deleted service ${service.id}`,
      `Autopay ${sub.razorpaySubscriptionId} charged payment ${payment.id} for service ${service.id}, which is ${service.status}. Refund it and cancel the subscription in the Razorpay dashboard.`
    );
    return;
  }
  await resumeAfterPayment(service.id);
}

/** Records a renewal charge as a paid invoice. Idempotent on the Razorpay payment ID. */
async function recordRenewal(sub: Subscription, payment: PaymentEntity) {
  const expectedPaise = sub.amount + sub.gstAmount + sub.processingFee;
  if (payment.amount !== expectedPaise) {
    console.warn(`[webhook] renewal ${payment.id} amount ${payment.amount} ≠ expected ${expectedPaise}`);
  }

  // Normal case for the first charge (already recorded by checkout) and for redelivered webhooks.
  if (await prisma.payment.findUnique({ where: { razorpayPaymentId: payment.id }, select: { id: true } })) return;

  const invoiceNumber = generateInvoiceNumber();
  try {
    await prisma.payment.create({
      data: {
        userId: sub.userId,
        serviceId: sub.serviceId,
        subscriptionId: sub.id,
        amount: sub.amount,
        gstAmount: sub.gstAmount,
        processingFee: sub.processingFee,
        razorpayPaymentId: payment.id,
        status: "SUCCESS",
        invoiceNumber,
      },
    });
  } catch (err) {
    // Two deliveries of the same charge raced past the check above.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    throw err;
  }

  const service = await prisma.service.findUnique({
    where: { id: sub.serviceId! },
    include: { user: true, plan: true },
  });
  if (!service) return;

  await sendInvoiceEmail(service.user.email, service.user.name, {
    invoiceNumber,
    planName: service.plan.name,
    amount: sub.amount,
    gstAmount: sub.gstAmount,
    processingFee: sub.processingFee,
  }).catch(console.error);
  await prisma.notification
    .create({
      data: {
        userId: sub.userId,
        title: "Renewal successful",
        message: `Autopay renewed your ${service.plan.name} server${sub.currentEnd ? ` until ${formatDate(sub.currentEnd)}` : ""}.`,
      },
    })
    .catch(console.error);
}

async function notifyRetrying(sub: Subscription) {
  const user = await prisma.user.findUnique({ where: { id: sub.userId } });
  if (!user) return;
  await prisma.notification
    .create({
      data: {
        userId: sub.userId,
        title: "Autopay payment failed",
        message: "Your renewal payment failed. Razorpay will retry automatically over the next few days.",
      },
    })
    .catch(console.error);
  await sendBillingNoticeEmail(user.email, user.name, {
    subject: "Your Sowsi Cloud renewal payment failed",
    heading: "Renewal payment failed",
    tone: "warning",
    paragraphs: [
      "We couldn't collect your server renewal payment. Razorpay will retry automatically over the next few days.",
      "Please make sure your card or UPI account has enough balance. If the retries also fail, your server will be suspended — you can switch to a different payment method any time by restarting autopay from your dashboard.",
    ],
    cta: { label: "Manage autopay", url: `${APP_URL}/dashboard/services` },
  }).catch(console.error);
}

async function notifyAutopayEnded(sub: Subscription, event: string) {
  const service = sub.serviceId
    ? await prisma.service.findUnique({ where: { id: sub.serviceId }, include: { user: true, plan: true } })
    : null;
  if (!service || service.status === "DELETED") return;

  const paidUntil = formatDate(service.nextBillingDate);
  const reason = event === "subscription.completed" ? "has reached the end of its authorised period" : "was cancelled";
  await prisma.notification
    .create({
      data: {
        userId: service.userId,
        title: "Autopay stopped",
        message: `Autopay for your ${service.plan.name} server ${reason}. It's paid until ${paidUntil} — restart autopay to keep it running.`,
      },
    })
    .catch(console.error);
  await sendBillingNoticeEmail(service.user.email, service.user.name, {
    subject: `Autopay stopped for your ${service.plan.name} server`,
    heading: "Autopay has stopped",
    tone: "warning",
    paragraphs: [
      `Autopay for your <strong>${service.plan.name}</strong> server ${reason}, so it won't renew automatically.`,
      `Your server keeps running until <strong>${paidUntil}</strong>. Restart autopay before then to avoid it being suspended.`,
    ],
    cta: { label: "Restart autopay", url: `${APP_URL}/dashboard/services` },
  }).catch(console.error);
}
