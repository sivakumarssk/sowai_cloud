import type { Order, Payment, Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateInvoiceNumber } from "@/lib/razorpay";
import { sendInvoiceEmail } from "@/lib/email";
import { provisioningQueue } from "@/lib/queue/provisioningQueue";
import { addMonths } from "@/lib/pricing";

type FulfillResult = { serviceId: string; orderId: string } | null;

/**
 * Marks the order's checkout payment as paid, creates its Service and starts
 * provisioning in the background. Called from both the checkout verify route
 * (fast path) and the webhook (backup if the customer closes the tab); only
 * the first caller does the work, later ones get the existing serviceId.
 */
async function fulfill(
  payment: Payment & { order: Order & { plan: Plan } },
  razorpayPaymentId: string,
  subscriptionId: string | null
): Promise<FulfillResult> {
  const order = payment.order;
  const invoiceNumber = generateInvoiceNumber();
  const subscription = subscriptionId ? await prisma.subscription.findUnique({ where: { id: subscriptionId } }) : null;
  // Paid through the prepaid term; for autopay that's exactly when the first renewal is scheduled.
  const paidUntil =
    subscription?.chargeAt && subscription.chargeAt > new Date() && order.billingCycle > 1
      ? subscription.chargeAt
      : addMonths(new Date(), order.billingCycle);
  const addons = Array.isArray(order.addons) ? order.addons.map(String) : [];

  const created = await prisma.$transaction(async (tx) => {
    // Row-level claim: a concurrent caller blocks here until this transaction
    // commits, then sees SUCCESS and gets count 0. REFUNDED is excluded so a
    // late webhook can't re-provision a refunded order.
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: { in: ["PENDING", "FAILED"] } },
      data: { status: "SUCCESS", razorpayPaymentId, invoiceNumber },
    });
    if (claimed.count === 0) return null;

    const service = await tx.service.create({
      data: {
        userId: order.userId,
        planId: order.planId,
        orderId: order.id,
        status: "PROVISIONING",
        provisioningPct: 0,
        provisioningStep: "Starting...",
        hostname: order.hostname,
        region: order.region,
        osImage: order.osImage,
        stackPreset: order.stackPreset,
        hasCoolify: addons.includes("coolify"),
        nextBillingDate: paidUntil,
      },
    });
    await tx.order.update({ where: { id: order.id }, data: { status: "PAID" } });
    await tx.payment.update({ where: { id: payment.id }, data: { serviceId: service.id } });
    if (subscriptionId) {
      await tx.subscription.update({ where: { id: subscriptionId }, data: { serviceId: service.id } });
    }
    return service;
  });

  if (!created) {
    const existing = await prisma.service.findUnique({ where: { orderId: order.id }, select: { id: true } });
    return existing ? { serviceId: existing.id, orderId: order.id } : null;
  }

  // Fire and forget — provisioning takes minutes and must not block the response.
  await provisioningQueue.add({ serviceId: created.id });

  const user = await prisma.user.findUnique({ where: { id: order.userId } });
  if (user) {
    sendInvoiceEmail(user.email, user.name, {
      invoiceNumber,
      planName: order.plan.name,
      amount: payment.amount,
      gstAmount: payment.gstAmount,
      processingFee: payment.processingFee,
    }).catch(console.error);
    await prisma.notification
      .create({
        data: {
          userId: order.userId,
          title: "Payment received",
          message: `Payment confirmed for ${order.plan.name}. We're setting up your server now.`,
        },
      })
      .catch(console.error);
  }

  return { serviceId: created.id, orderId: order.id };
}

/** One-time Razorpay order payments (checkouts started before autopay). */
export async function fulfillPayment(razorpayOrderId: string, razorpayPaymentId: string): Promise<FulfillResult> {
  const payment = await prisma.payment.findFirst({
    where: { razorpayOrderId },
    include: { order: { include: { plan: true } } },
  });
  if (!payment || !payment.order) return null;
  return fulfill({ ...payment, order: payment.order }, razorpayPaymentId, null);
}

/** First charge of an autopay subscription created at checkout. */
export async function fulfillSubscriptionPayment(
  razorpaySubscriptionId: string,
  razorpayPaymentId: string
): Promise<FulfillResult> {
  const subscription = await prisma.subscription.findUnique({ where: { razorpaySubscriptionId } });
  if (!subscription?.orderId) return null;

  const payment = await prisma.payment.findFirst({
    where: { subscriptionId: subscription.id, orderId: subscription.orderId },
    include: { order: { include: { plan: true } } },
  });
  if (!payment || !payment.order) return null;
  return fulfill({ ...payment, order: payment.order }, razorpayPaymentId, subscription.id);
}
