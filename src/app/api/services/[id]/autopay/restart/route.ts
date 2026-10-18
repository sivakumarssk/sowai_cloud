import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import {
  createSubscription,
  cancelAutopayForService,
  latestSubscription,
  razorpayErrorMessage,
} from "@/lib/billing/subscriptions";
import { gstOn, processingFeeOn } from "@/lib/pricing";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Sets up autopay again after it was cancelled, completed or halted (or to
 * switch payment method while Razorpay is retrying a failed charge).
 *
 * - Server still inside its paid period → billing starts when that period
 *   ends; the customer only authorises the mandate now.
 * - Server suspended / period over → charged immediately; the
 *   subscription.charged webhook then reactivates the server.
 *
 * Returns Razorpay's hosted authorisation link to redirect the customer to.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { id } = await params;
  const service = await prisma.service.findUnique({ where: { id }, include: { user: true, order: true } });
  if (!service || service.userId !== session.userId) return apiError("Service not found", 404);
  if (service.status !== "ACTIVE" && service.status !== "SUSPENDED") {
    return apiError("Autopay can only be set up for active or suspended servers", 409);
  }

  const inPaidPeriod = service.status === "ACTIVE" && service.nextBillingDate.getTime() > Date.now() + HOUR_MS;
  const timing = { chargesNow: !inPaidPeriod, startsOn: inPaidPeriod ? service.nextBillingDate : null };

  const latest = await latestSubscription(service.id);
  if (latest && (latest.status === "ACTIVE" || latest.status === "AUTHENTICATED")) {
    return apiError("Autopay is already active for this server", 409);
  }
  // Renewal terms (never the intro price): the last subscription, or the original order's renewal amount.
  const order = service.order;
  const terms = latest
    ? { billingCycle: latest.billingCycle, amount: latest.amount, gstAmount: latest.gstAmount, processingFee: latest.processingFee }
    : order
    ? (() => {
        const amount = order.renewalAmount ?? order.amount;
        return {
          billingCycle: order.renewalAmount !== null ? 1 : order.billingCycle,
          amount,
          gstAmount: gstOn(amount),
          processingFee: processingFeeOn(amount),
        };
      })()
    : null;
  if (!terms) return apiError("No billing terms found for this server — please contact support", 409);

  try {
    // Halted / pending subscriptions must not be able to charge alongside the
    // new one, and an unfinished earlier restart may have stale start terms.
    await cancelAutopayForService(service.id);
  } catch (err) {
    console.error("[autopay-restart] cancelling previous autopay failed:", err);
    return apiError("Couldn't stop the previous autopay. Please try again or contact support.", 502);
  }

  try {
    const sub = await createSubscription({
      userId: service.userId,
      serviceId: service.id,
      billingCycle: terms.billingCycle,
      amount: terms.amount,
      gstAmount: terms.gstAmount,
      processingFee: terms.processingFee,
      startAt: inPaidPeriod ? service.nextBillingDate : undefined,
      customer: { email: service.user.email, phone: service.user.phone },
      notes: latest ? { restartOf: latest.razorpaySubscriptionId } : undefined,
    });
    if (!sub.shortUrl) return apiError("Razorpay did not return an authorisation link", 502);
    return apiSuccess({ shortUrl: sub.shortUrl, ...timing });
  } catch (err) {
    console.error("[autopay-restart] creating subscription failed:", err);
    return apiError(`Couldn't set up autopay: ${razorpayErrorMessage(err)}`, 502);
  }
}
