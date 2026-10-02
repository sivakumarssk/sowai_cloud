import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import { getTotalPrice, calculateGST, isBillingCycle } from "@/lib/pricing";
import { DEFAULT_REGION, getRegion, getPreset, getOsImage, getPresetsForCategory } from "@/lib/provisioning/catalog";

const ADDON_CATALOG: Record<string, number> = {
  coolify: 99,
  backups: 199,
  "extra-ip": 149,
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const body = await req.json();
  const { planId, billingCycle, addons, region, osImage, stackPreset, hostname } = body as {
    planId?: string;
    billingCycle?: number;
    addons?: string[];
    region?: string;
    osImage?: string;
    stackPreset?: string;
    hostname?: string;
  };

  if (!planId) return apiError("Plan ID is required");
  if (!isBillingCycle(billingCycle)) return apiError("Invalid billing cycle");
  if (!hostname || !/^[a-zA-Z0-9-]{3,63}$/.test(hostname)) {
    return apiError("Hostname must be 3-63 characters (letters, numbers, hyphens only)");
  }

  const plan = await prisma.plan.findUnique({ where: { id: planId, isActive: true } });
  if (!plan) return apiError("Plan not found", 404);

  const resolvedRegion = getRegion(region || DEFAULT_REGION);
  if (!resolvedRegion) return apiError("Invalid region");

  const availablePresets = getPresetsForCategory(plan.category);
  const preset = stackPreset ? getPreset(stackPreset) : availablePresets[0];
  if (!preset || !availablePresets.some((p) => p.value === preset.value)) {
    return apiError("Invalid stack preset for this plan category");
  }

  const resolvedOsValue = preset.lockedOs || osImage || "ubuntu-22.04";
  if (!getOsImage(resolvedOsValue)) return apiError("Invalid OS image");

  const validAddons = (addons || []).filter((id) => id in ADDON_CATALOG);
  const addonMonthlyTotal = validAddons.reduce((sum, id) => sum + ADDON_CATALOG[id], 0);

  const planTotal = getTotalPrice(plan.price, billingCycle);
  const addonTotal = addonMonthlyTotal * billingCycle;
  const subtotal = planTotal + addonTotal;
  const gstAmount = calculateGST(subtotal);

  const order = await prisma.order.create({
    data: {
      userId: session.userId,
      planId: plan.id,
      status: "AWAITING_PAYMENT",
      billingCycle,
      addons: validAddons,
      region: resolvedRegion.value,
      osImage: resolvedOsValue,
      stackPreset: preset.value,
      hostname,
      amount: subtotal,
      gstAmount,
    },
  });

  return apiSuccess({ orderId: order.id });
}
