import crypto from "node:crypto";
import { Prisma, type Subscription, type SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { razorpay } from "@/lib/razorpay";
import type { Subscriptions } from "razorpay/dist/types/subscriptions";

type RzpSubscription = Subscriptions.RazorpaySubscription;

/** Autopay is set up and will (try to) charge the next renewal. */
export const LIVE_STATUSES: SubscriptionStatus[] = ["AUTHENTICATED", "ACTIVE", "PENDING"];
/** Razorpay will never charge these again. */
export const TERMINAL_STATUSES: SubscriptionStatus[] = ["CANCELLED", "COMPLETED", "EXPIRED"];

const ALL_STATUSES = new Set<string>([
  "CREATED", "AUTHENTICATED", "ACTIVE", "PENDING", "HALTED", "PAUSED", "CANCELLED", "COMPLETED", "EXPIRED",
]);

export function toSubscriptionStatus(razorpayStatus: string): SubscriptionStatus {
  const upper = razorpayStatus.toUpperCase();
  if (!ALL_STATUSES.has(upper)) throw new Error(`Unknown Razorpay subscription status "${razorpayStatus}"`);
  return upper as SubscriptionStatus;
}

/** 1 → monthly/1, 12 → yearly/1, 24 → yearly/2 */
export function cycleToPeriod(months: number): { period: "monthly" | "yearly"; interval: number } {
  return months % 12 === 0 ? { period: "yearly", interval: months / 12 } : { period: "monthly", interval: months };
}

export function cycleLabel(months: number): string {
  if (months === 1) return "Monthly";
  if (months % 12 === 0) return months === 12 ? "Yearly" : `Every ${months / 12} years`;
  return `Every ${months} months`;
}

/** Number of charges Razorpay is authorised for — about 5 years' worth. */
function totalCountFor(months: number): number {
  return Math.max(1, Math.floor(60 / months));
}

const unix = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000) : null);

/** Razorpay SDK errors are plain objects: { statusCode, error: { code, description } }. */
export function razorpayErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const desc = (err as { error?: { description?: string } })?.error?.description;
  return desc ?? JSON.stringify(err);
}

/**
 * Razorpay plans are immutable, so one plan per (cycle, amount charged) is
 * created on first use and reused afterwards.
 */
async function getOrCreateRazorpayPlan(months: number, amountPaise: number): Promise<string> {
  const { period, interval } = cycleToPeriod(months);
  const key = `${period}-${interval}-${amountPaise}`;

  const existing = await prisma.razorpayPlan.findUnique({ where: { key } });
  if (existing) return existing.razorpayPlanId;

  const rupees = (amountPaise / 100).toLocaleString("en-IN");
  const plan = await razorpay.plans.create({
    period,
    interval,
    item: {
      name: `Sowsi Cloud – ${cycleLabel(months)}`,
      amount: amountPaise,
      currency: "INR",
      description: `₹${rupees} incl. processing, ${cycleLabel(months).toLowerCase()}`,
    },
    notes: { key },
  });

  try {
    await prisma.razorpayPlan.create({
      data: { key, razorpayPlanId: plan.id, period, interval, amountPaise },
    });
    return plan.id;
  } catch (err) {
    // Another request created the same plan concurrently — use theirs.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return (await prisma.razorpayPlan.findUniqueOrThrow({ where: { key } })).razorpayPlanId;
    }
    throw err;
  }
}

function fieldsFrom(rzp: RzpSubscription) {
  return {
    status: toSubscriptionStatus(rzp.status),
    currentStart: unix(rzp.current_start),
    currentEnd: unix(rzp.current_end),
    chargeAt: unix(rzp.charge_at),
    paidCount: rzp.paid_count ?? 0,
    shortUrl: rzp.short_url ?? null,
  };
}

/**
 * Creates a Razorpay autopay subscription and its DB record. All amounts in paise.
 *
 * - No `startAt`: the first recurring charge is taken when the customer
 *   authorises the mandate.
 * - `startAt` + `upfront`: the upfront amount (e.g. a prepaid intro term) is
 *   charged at authorisation and recurring charges begin at `startAt`.
 * - `startAt` alone: only the mandate is authorised now.
 */
export async function createSubscription(input: {
  userId: string;
  serviceId?: string;
  orderId?: string;
  /** Months between recurring charges. */
  billingCycle: number;
  /** Recurring charge, excl. GST and processing fee. */
  amount: number;
  gstAmount: number;
  processingFee: number;
  startAt?: Date;
  upfront?: { amount: number; label: string };
  customer: { email: string; phone?: string | null };
  notes?: Record<string, string>;
}): Promise<Subscription> {
  const amountPaise = input.amount + input.gstAmount + input.processingFee;
  const razorpayPlanId = await getOrCreateRazorpayPlan(input.billingCycle, amountPaise);

  const rzp = await razorpay.subscriptions.create({
    plan_id: razorpayPlanId,
    total_count: totalCountFor(input.billingCycle),
    quantity: 1,
    customer_notify: 1,
    ...(input.startAt && { start_at: Math.floor(input.startAt.getTime() / 1000) }),
    ...(input.upfront && {
      addons: [{ item: { name: input.upfront.label, amount: input.upfront.amount, currency: "INR" } }],
    }),
    notes: {
      userId: input.userId,
      ...(input.serviceId && { serviceId: input.serviceId }),
      ...(input.orderId && { orderId: input.orderId }),
      ...input.notes,
    },
    notify_info: {
      notify_email: input.customer.email,
      ...(input.customer.phone && { notify_phone: input.customer.phone }),
    },
  });

  return prisma.subscription.create({
    data: {
      userId: input.userId,
      serviceId: input.serviceId,
      orderId: input.orderId,
      razorpaySubscriptionId: rzp.id,
      razorpayPlanId,
      billingCycle: input.billingCycle,
      amount: input.amount,
      gstAmount: input.gstAmount,
      processingFee: input.processingFee,
      ...fieldsFrom(rzp),
    },
  });
}

/** Writes a Razorpay subscription entity (from the API or a webhook payload) into the DB. */
export function applyRazorpayState(rzp: RzpSubscription): Promise<Subscription> {
  return prisma.subscription.update({
    where: { razorpaySubscriptionId: rzp.id },
    data: fieldsFrom(rzp),
  });
}

/** Pulls the latest state from Razorpay into the DB. */
export async function syncSubscription(razorpaySubscriptionId: string): Promise<Subscription> {
  return applyRazorpayState(await razorpay.subscriptions.fetch(razorpaySubscriptionId));
}

export type { RzpSubscription };

/** Cancels immediately at Razorpay (no further charges). Already-ended subscriptions are left alone. */
export async function cancelSubscription(sub: Subscription): Promise<Subscription> {
  if (TERMINAL_STATUSES.includes(sub.status)) return sub;
  try {
    await razorpay.subscriptions.cancel(sub.razorpaySubscriptionId, false);
  } catch (err) {
    // Razorpay refuses to cancel something that already ended on its side —
    // re-sync and only fail if it's genuinely still able to charge.
    const synced = await syncSubscription(sub.razorpaySubscriptionId).catch(() => null);
    if (!synced || !TERMINAL_STATUSES.includes(synced.status)) {
      throw new Error(`Could not cancel autopay ${sub.razorpaySubscriptionId}: ${razorpayErrorMessage(err)}`);
    }
    return synced;
  }
  return prisma.subscription.update({
    where: { id: sub.id },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
}

/** Cancels every subscription of a service that could still charge the customer. Throws if any can't be cancelled. */
export async function cancelAutopayForService(serviceId: string): Promise<void> {
  const subs = await prisma.subscription.findMany({
    where: { serviceId, status: { notIn: TERMINAL_STATUSES } },
  });
  for (const sub of subs) await cancelSubscription(sub);
}

export function latestSubscription(serviceId: string) {
  return prisma.subscription.findFirst({ where: { serviceId }, orderBy: { createdAt: "desc" } });
}

/** Checkout signature for subscriptions: HMAC_SHA256(payment_id + "|" + subscription_id, key_secret). */
export function verifySubscriptionSignature(paymentId: string, subscriptionId: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${paymentId}|${subscriptionId}`).digest("hex");
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * ID of the first paid payment on a subscription (the authorisation charge),
 * looked up from its invoices. Used when the checkout callback never reached
 * us and no subscription.charged will arrive until the prepaid term ends.
 */
export async function findFirstPaidPaymentId(razorpaySubscriptionId: string): Promise<string | null> {
  const { items } = await razorpay.invoices.all({ subscription_id: razorpaySubscriptionId });
  const paid = (items as { status: string; payment_id?: string | null; paid_at?: number | null }[])
    .filter((i) => i.status === "paid" && i.payment_id)
    .sort((a, b) => (a.paid_at ?? 0) - (b.paid_at ?? 0));
  return paid[0]?.payment_id ?? null;
}
