import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import { createSubscription, razorpayErrorMessage } from "@/lib/billing/subscriptions";
import { type PriceQuote, addMonths, gstOn, processingFeeOn, CYCLES, cycleKeyFromMonths } from "@/lib/pricing";

/**
 * Starts checkout for an order as a Razorpay autopay subscription (all paise):
 *
 * - Monthly: recurring monthly charge; the first one is taken at authorisation.
 * - 1 / 2 years: the prepaid term (intro price) is charged upfront at
 *   authorisation; monthly renewals at the renewal rate start when it ends.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { orderId } = await req.json();
  if (!orderId) return apiError("Order ID is required");

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { plan: true, user: true },
  });

  if (!order || order.userId !== session.userId) {
    return apiError("Order not found", 404);
  }
  if (order.status === "PAID") return apiError("This order has already been paid for");

  const firstTermTotal = order.amount + order.gstAmount + order.processingFee;
  const prepaid = order.billingCycle > 1;
  // Orders from before intro pricing have no renewal amount: they renew at the same price and cycle.
  const recurringAmount = order.renewalAmount ?? order.amount;
  const recurringCycle = order.renewalAmount !== null ? 1 : order.billingCycle;
  // Renew on the charges the customer was quoted (the rate may have changed since);
  // orders without a saved quote use the current rate.
  const quotedRenewal = (order.quote as PriceQuote | null)?.renewal;
  const recurringFee =
    quotedRenewal && quotedRenewal.monthlySubtotal === recurringAmount
      ? quotedRenewal.processingFee
      : processingFeeOn(recurringAmount);

  // Reuse the subscription from an earlier "Pay" click that wasn't completed.
  let subscription = await prisma.subscription.findFirst({
    where: { orderId: order.id, status: "CREATED" },
    orderBy: { createdAt: "desc" },
  });

  if (!subscription) {
    try {
      subscription = await createSubscription({
        userId: order.userId,
        orderId: order.id,
        billingCycle: recurringCycle,
        amount: recurringAmount,
        gstAmount: gstOn(recurringAmount),
        processingFee: recurringFee,
        ...(prepaid && {
          startAt: addMonths(new Date(), order.billingCycle),
          upfront: {
            amount: firstTermTotal,
            label: `${order.plan.name} — first ${CYCLES[cycleKeyFromMonths(order.billingCycle)].label.toLowerCase()}`,
          },
        }),
        customer: { email: order.user.email, phone: order.user.phone },
      });
    } catch (err) {
      console.error("[create-order] Razorpay subscription failed:", err);
      return apiError(`Could not start payment: ${razorpayErrorMessage(err)}`, 502);
    }
  }

  const existingPayment = await prisma.payment.findFirst({
    where: { orderId: order.id, subscriptionId: subscription.id },
  });
  if (!existingPayment) {
    await prisma.payment.create({
      data: {
        userId: session.userId,
        orderId: order.id,
        subscriptionId: subscription.id,
        amount: order.amount,
        gstAmount: order.gstAmount,
        processingFee: order.processingFee,
        currency: "INR",
        status: "PENDING",
      },
    });
  }

  return apiSuccess({
    razorpaySubscriptionId: subscription.razorpaySubscriptionId,
    amount: firstTermTotal,
    currency: "INR",
    planName: order.plan.name,
    billingCycle: order.billingCycle,
    orderId: order.id,
  });
}
