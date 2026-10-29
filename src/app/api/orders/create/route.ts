import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import { availableCycles, cycleKeyFromMonths, isCycleKey, quotePrice, resolveAddons, CYCLES } from "@/lib/pricing";
import { findActivePlan, addonsForPlan, isReturningCustomer, toPublicPlan, availabilityChecker } from "@/lib/plans";
import {
  DEFAULT_REGION,
  getRegion,
  getPreset,
  getOsImage,
  getPresetsForCategory,
  hostnameError,
  normalizeHostname,
} from "@/lib/provisioning/catalog";

/**
 * Creates an order with a server-side price quote. Prices always come from
 * the database — anything amount-like sent by the client is ignored.
 *
 * Body: { planId, billingCycle: "monthly" | "1year" | "2year", addons: string[], region, osImage, stackPreset, hostname }
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const body = await req.json();
  const { planId, billingCycle, addons, region, osImage, stackPreset, hostname: rawHostname } = body as {
    planId?: string;
    billingCycle?: string | number;
    addons?: string[];
    region?: string;
    osImage?: string;
    stackPreset?: string;
    hostname?: string;
  };

  if (!planId) return apiError("Plan ID is required");
  // Accept the cycle key, or months (1 / 12 / 24) from older clients.
  const cycle = typeof billingCycle === "number" ? cycleKeyFromMonths(billingCycle) : billingCycle;
  if (!isCycleKey(cycle)) return apiError("Invalid billing cycle");
  const hostname = normalizeHostname(typeof rawHostname === "string" ? rawHostname : "");
  const nameError = hostnameError(hostname, "Name");
  if (nameError) return apiError(nameError);

  const plan = await findActivePlan(planId);
  if (!plan) return apiError("Plan not found", 404);
  const availability = (await availabilityChecker())(plan);
  if (!availability.orderable) return apiError(`${plan.name} isn't available right now`, 409);
  const publicPlan = toPublicPlan(plan, availability);
  if (!availableCycles(publicPlan).includes(cycle)) {
    return apiError(`${plan.name} isn't available on the ${CYCLES[cycle].label} cycle`);
  }

  const resolvedRegion = getRegion(region || DEFAULT_REGION);
  if (!resolvedRegion) return apiError("Invalid region");

  const availablePresets = getPresetsForCategory(plan.category);
  const preset = stackPreset ? getPreset(stackPreset) : availablePresets[0];
  if (!preset || !availablePresets.some((p) => p.value === preset.value)) {
    return apiError("Invalid stack preset for this plan category");
  }

  const resolvedOsValue = preset.lockedOs || osImage || "ubuntu-22.04";
  if (!getOsImage(resolvedOsValue)) return apiError("Invalid OS image");

  const chosenAddons = resolveAddons(await addonsForPlan(plan), Array.isArray(addons) ? addons : [], plan.category);
  const returning = await isReturningCustomer(session.userId, plan.id);
  const quote = quotePrice(publicPlan, cycle, chosenAddons, { returning });

  const order = await prisma.order.create({
    data: {
      userId: session.userId,
      planId: plan.id,
      status: "AWAITING_PAYMENT",
      billingCycle: quote.months,
      addons: chosenAddons.map((a) => a.slug),
      region: resolvedRegion.value,
      osImage: resolvedOsValue,
      stackPreset: preset.value,
      hostname,
      amount: quote.subtotal,
      gstAmount: quote.gst,
      processingFee: quote.processingFee,
      isIntroPrice: quote.isIntro,
      renewalAmount: quote.renewal.monthlySubtotal,
      quote,
    },
  });

  return apiSuccess({ orderId: order.id, quote });
}
