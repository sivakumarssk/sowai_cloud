// Pricing rules shared by the pricing page, order page, order API and
// checkout. Pure functions only (safe in client components).
// All amounts are in PAISE (₹599 = 59900).

export type CycleKey = "monthly" | "1year" | "2year";

export const CYCLES: Record<CycleKey, { months: 1 | 12 | 24; label: string; per: string; billed: string }> = {
  monthly: { months: 1, label: "Monthly", per: "month", billed: "Billed monthly" },
  "1year": { months: 12, label: "1 Year", per: "year", billed: "Billed annually" },
  "2year": { months: 24, label: "2 Years", per: "2 years", billed: "Billed every 2 years" },
};
export const CYCLE_KEYS: CycleKey[] = ["monthly", "1year", "2year"];

export function isCycleKey(value: unknown): value is CycleKey {
  return typeof value === "string" && value in CYCLES;
}

export function cycleKeyFromMonths(months: number): CycleKey {
  return months === 24 ? "2year" : months === 12 ? "1year" : "monthly";
}

/**
 * Payment charges passed on to the customer.
 * 4% because Razorpay charges 3-4% on autopay (subscription) payments.
 */
export const PROCESSING_FEE_PERCENT = 4;
/** GST on the plan + add-ons subtotal. Stored separately (invoices list it) but shown inside "Charges" in the UI. */
export const GST_PERCENT = 18;
/** What the UI calls "Charges": payment fee + GST, as one percentage of the subtotal. */
export const CHARGES_PERCENT = PROCESSING_FEE_PERCENT + GST_PERCENT;

export function processingFeeOn(subtotal: number): number {
  return Math.round((subtotal * PROCESSING_FEE_PERCENT) / 100);
}

export function gstOn(subtotal: number): number {
  return Math.round((subtotal * GST_PERCENT) / 100);
}

export const categoryLabel: Record<string, string> = {
  SHARED: "Shared Hosting",
  VPS: "VPS Hosting",
  WORDPRESS: "Managed WordPress",
  STORAGE: "S4 Object Storage",
  DEDICATED: "Dedicated Server",
};

export type PricedPlan = {
  name: string;
  category: string;
  priceMonthly: number | null;
  priceIntro1Year: number | null;
  priceIntro2Year: number | null;
  priceRenewal: number | null;
  /** Dedicated plans' 1/2-year prices are term discounts for everyone, not new-customer intro offers. */
  isDedicated?: boolean;
};

export type PricedAddon = {
  slug: string;
  name: string;
  description: string;
  priceMonthly: number;
  exclusiveGroup: string | null;
};

/** Billing cycles a plan can be bought on (those it has a price for). */
export function availableCycles(plan: PricedPlan): CycleKey[] {
  return CYCLE_KEYS.filter((c) => firstTermRate(plan, c, false) !== null);
}

/**
 * Monthly rate for the first term. Prepaid cycles get the intro rate for new
 * customers; returning customers pay the renewal rate (except on dedicated
 * plans, whose prepaid discount applies to everyone). Monthly has no intro.
 */
export function firstTermRate(plan: PricedPlan, cycle: CycleKey, returning: boolean): number | null {
  if (cycle === "monthly") return plan.priceMonthly;
  const intro = cycle === "1year" ? plan.priceIntro1Year : plan.priceIntro2Year;
  if (intro === null) return null;
  if (plan.isDedicated) return intro;
  return returning ? plan.priceRenewal ?? intro : intro;
}

/** Monthly rate autopay charges after the first term. */
export function renewalRate(plan: PricedPlan, cycle: CycleKey): number | null {
  return cycle === "monthly" ? plan.priceMonthly : plan.priceRenewal;
}

/** "Save X%" of the intro rate versus paying monthly. */
export function savingsPercent(plan: PricedPlan, cycle: CycleKey): number {
  const rate = firstTermRate(plan, cycle, false);
  if (!plan.priceMonthly || rate === null || cycle === "monthly") return 0;
  return Math.round(((plan.priceMonthly - rate) / plan.priceMonthly) * 100);
}

/**
 * Keeps only known addons that apply to the plan's category, and only one
 * per exclusive group (the last one listed wins).
 */
export function resolveAddons<A extends PricedAddon & { categories?: string[] }>(
  all: A[],
  slugs: string[],
  category: string
): A[] {
  const byGroup = new Map<string, A>();
  const chosen: A[] = [];
  for (const slug of slugs) {
    const addon = all.find((a) => a.slug === slug && (!a.categories || a.categories.includes(category)));
    if (!addon || chosen.includes(addon)) continue;
    if (addon.exclusiveGroup) {
      const previous = byGroup.get(addon.exclusiveGroup);
      if (previous) chosen.splice(chosen.indexOf(previous), 1);
      byGroup.set(addon.exclusiveGroup, addon);
    }
    chosen.push(addon);
  }
  return chosen;
}

export type PriceQuote = {
  cycle: CycleKey;
  months: number;
  isIntro: boolean;
  /** Plan's monthly rate for the first term. */
  planRate: number;
  planTotal: number;
  addons: { slug: string; name: string; rate: number; total: number }[];
  subtotal: number;
  processingFee: number;
  gst: number;
  /** Due today. */
  total: number;
  /** What autopay charges every month once the first term ends. */
  renewal: {
    planRate: number;
    monthlySubtotal: number;
    processingFee: number;
    gst: number;
    monthlyTotal: number;
    startsAfterMonths: number;
  };
};

export function quotePrice(
  plan: PricedPlan,
  cycle: CycleKey,
  addons: PricedAddon[],
  { returning = false }: { returning?: boolean } = {}
): PriceQuote {
  const months = CYCLES[cycle].months;
  const planRate = firstTermRate(plan, cycle, returning);
  const renewPlanRate = renewalRate(plan, cycle);
  if (planRate === null || renewPlanRate === null) {
    throw new Error(`${plan.name} can't be bought on the ${CYCLES[cycle].label} cycle`);
  }

  const addonLines = addons.map((a) => ({ slug: a.slug, name: a.name, rate: a.priceMonthly, total: a.priceMonthly * months }));
  const planTotal = planRate * months;
  const subtotal = planTotal + addonLines.reduce((sum, a) => sum + a.total, 0);
  const fee = processingFeeOn(subtotal);
  const gst = gstOn(subtotal);

  const monthlySubtotal = renewPlanRate + addons.reduce((sum, a) => sum + a.priceMonthly, 0);
  const renewalFee = processingFeeOn(monthlySubtotal);
  const renewalGst = gstOn(monthlySubtotal);

  return {
    cycle,
    months,
    isIntro: cycle !== "monthly" && !returning && !plan.isDedicated,
    planRate,
    planTotal,
    addons: addonLines,
    subtotal,
    processingFee: fee,
    gst,
    total: subtotal + fee + gst,
    renewal: {
      planRate: renewPlanRate,
      monthlySubtotal,
      processingFee: renewalFee,
      gst: renewalGst,
      monthlyTotal: monthlySubtotal + renewalFee + renewalGst,
      startsAfterMonths: months,
    },
  };
}

/** 59900 → "₹599", 59950 → "₹599.50" */
export function formatINR(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Plan data the pricing and order pages need (serialisable for client components). */
export type PublicPlan = PricedPlan & {
  id: string;
  slug: string;
  isPopular: boolean;
  /** Guaranteed resources, flat monthly price (Dedicated tab). */
  isDedicated: boolean;
  features: string[];
  vcpu: number | null;
  ramGB: number | null;
  storageGB: number | null;
  bandwidthTB: number | null;
};

/** Addons a plan already includes (e.g. Coolify on VPS Pro) shouldn't be sold on top. */
export function addonIncludedInPlan(addonSlug: string, features: string[]): boolean {
  if (addonSlug === "coolify") return features.some((f) => /coolify/i.test(f));
  if (addonSlug === "s4Versioning") return features.some((f) => /versioning/i.test(f));
  if (addonSlug === "dailyBackup" || addonSlug === "weeklyBackup") {
    return features.some((f) => /backups? included/i.test(f));
  }
  return false;
}

/** "1 TB" for 1024+ GB, otherwise "500 GB". */
export function formatStorage(gb: number): string {
  return gb >= 1024 && gb % 1024 === 0 ? `${gb / 1024} TB` : `${gb} GB`;
}

/** Same day-of-month `months` later (clamped to month end: 31 Jan + 1 → 28/29 Feb). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d;
}
