import type { Addon, Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { addonIncludedInPlan, type PricedAddon, type PublicPlan } from "@/lib/pricing";

/** Feature bullets; older plans stored an object of label → text. */
export function planFeatures(plan: Pick<Plan, "features">): string[] {
  const f = plan.features;
  if (Array.isArray(f)) return f.map(String);
  if (f && typeof f === "object") return Object.values(f).map(String);
  return [];
}

export function toPublicPlan(plan: Plan): PublicPlan {
  return {
    id: plan.id,
    slug: plan.slug ?? plan.id,
    name: plan.name,
    category: plan.category,
    isPopular: plan.isPopular,
    isDedicated: plan.isDedicated,
    features: planFeatures(plan),
    priceMonthly: plan.priceMonthly,
    priceIntro1Year: plan.priceIntro1Year,
    priceIntro2Year: plan.priceIntro2Year,
    priceRenewal: plan.priceRenewal,
    vcpu: plan.vcpu,
    ramGB: plan.ramGB,
    storageGB: plan.storageGB,
    bandwidthTB: plan.bandwidthTB,
  };
}

export function toPricedAddon(addon: Addon): PricedAddon & { categories: string[] } {
  return {
    slug: addon.slug,
    name: addon.name,
    description: addon.description,
    priceMonthly: addon.priceMonthly,
    exclusiveGroup: addon.exclusiveGroup,
    categories: addon.categories,
  };
}

/** Active plan by URL slug ("VPS_PRO") or database id ("VPS_VPS_PRO"). */
export function findActivePlan(key: string) {
  return prisma.plan.findFirst({ where: { isActive: true, OR: [{ slug: key }, { id: key }] } });
}

/** Addons that can be bought with this plan (excluding ones the plan already includes). */
export async function addonsForPlan(plan: Plan) {
  const features = planFeatures(plan);
  const addons = await prisma.addon.findMany({
    where: { isActive: true, categories: { has: plan.category } },
    orderBy: { sortOrder: "asc" },
  });
  return addons.filter((a) => !addonIncludedInPlan(a.slug, features)).map(toPricedAddon);
}

/** Intro prices are for new customers: anyone who has had this plan before pays the renewal rate. */
export async function isReturningCustomer(userId: string, planId: string): Promise<boolean> {
  const previous = await prisma.service.count({
    // A setup that failed (and was refunded) doesn't count.
    where: { userId, planId, status: { not: "FAILED" } },
  });
  return previous > 0;
}
