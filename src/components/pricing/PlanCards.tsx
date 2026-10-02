"use client";

import Link from "next/link";
import {
  type BillingCycle,
  BILLING_OPTIONS,
  categoryLabel,
  getFullMonthlyPrice,
  getMonthlyPrice,
  getTotalPrice,
} from "@/lib/pricing";

export type { BillingCycle };
export { BILLING_OPTIONS, categoryLabel, getFullMonthlyPrice, getMonthlyPrice, getTotalPrice };

export type Plan = {
  id: string;
  name: string;
  category: string;
  tier: string;
  price: number;
  billingCycle: string;
  features: unknown;
  isActive: boolean;
};

export const popularNames = new Set(["Shared Business", "VPS Pro", "WordPress Business", "Storage Pro"]);

/* ── Plan card grid ── */
export function PlanGrid({ plans, cycle, premium = false }: { plans: Plan[]; cycle: BillingCycle; premium?: boolean }) {
  return (
    <div className={`grid gap-5 grid-cols-1 ${plans.length >= 2 ? "sm:grid-cols-2" : ""} ${plans.length >= 3 ? "lg:grid-cols-3" : ""}`}>
      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} cycle={cycle} premium={premium} />
      ))}
    </div>
  );
}

/* ── Single plan card ── */
export function PlanCard({ plan, cycle, premium }: { plan: Plan; cycle: BillingCycle; premium: boolean }) {
  const isPopular      = popularNames.has(plan.name);
  const featureList    = Object.values(plan.features as Record<string, string>);
  const fullMonthly    = getFullMonthlyPrice(plan.price);
  const monthlyPrice   = getMonthlyPrice(plan.price, cycle);
  const totalPrice     = getTotalPrice(plan.price, cycle);
  const hasDiscount    = cycle !== 1;
  const currentOpt     = BILLING_OPTIONS.find(o => o.months === cycle)!;

  if (premium) {
    return (
      <div className="rounded-2xl p-6 flex flex-col transition-all duration-200"
        style={{ background: "rgba(168,85,247,0.06)", border: "1px solid rgba(168,85,247,0.2)" }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = "rgba(168,85,247,0.45)")}
        onMouseLeave={e => (e.currentTarget.style.borderColor = "rgba(168,85,247,0.2)")}>

        <h3 className="text-xl font-bold text-white mb-0.5">{plan.name}</h3>
        <p className="text-xs mb-5" style={{ color: "#C084FC" }}>{categoryLabel[plan.category] ?? plan.category}</p>

        <PriceBlock monthlyPrice={monthlyPrice} originalPrice={fullMonthly} totalPrice={totalPrice} cycle={cycle} hasDiscount={hasDiscount} cycleLabel={currentOpt.sublabel} isPopular={false} accent="#A855F7" />

        <ul className="flex flex-col gap-2 flex-1 mb-6">
          {featureList.map((feat) => (
            <li key={feat} className="flex items-start gap-2 text-sm">
              <svg className="w-4 h-4 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20" style={{ color: "#A855F7" }}>
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              <span className="text-gray-300">{feat}</span>
            </li>
          ))}
        </ul>
        <Link href={`/order/${plan.id}`}>
          <button className="w-full py-2.5 rounded-xl font-semibold text-sm text-white transition-all hover:opacity-90"
            style={{ background: "linear-gradient(135deg, #7C3AED, #A855F7)" }}>
            Get Started
          </button>
        </Link>
      </div>
    );
  }

  return (
    <div className="relative rounded-2xl p-6 flex flex-col transition-all duration-200"
      style={isPopular
        ? { background: "linear-gradient(145deg, #1B4FE8, #1540C4)", border: "2px solid #1B4FE8", boxShadow: "0 20px 60px rgba(27,79,232,0.3)" }
        : { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
      onMouseEnter={e => { if (!isPopular) e.currentTarget.style.borderColor = "rgba(27,79,232,0.4)"; }}
      onMouseLeave={e => { if (!isPopular) e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; }}>

      {isPopular && (
        <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 text-xs font-bold px-3 py-1 rounded-full whitespace-nowrap"
          style={{ background: "#FBBF24", color: "#000" }}>
          MOST POPULAR
        </div>
      )}

      <h3 className="text-xl font-bold text-white mb-4">{plan.name}</h3>

      <PriceBlock
        monthlyPrice={monthlyPrice}
        originalPrice={fullMonthly}
        totalPrice={totalPrice}
        cycle={cycle}
        hasDiscount={hasDiscount}
        cycleLabel={currentOpt.sublabel}
        isPopular={isPopular}
        accent={isPopular ? "#93C5FD" : "#60A5FA"}
      />

      <ul className="flex flex-col gap-2.5 flex-1 mb-6">
        {featureList.map((feat) => (
          <li key={feat} className="flex items-start gap-2 text-sm">
            <svg className={`w-4 h-4 shrink-0 mt-0.5 ${isPopular ? "text-blue-200" : "text-blue-500"}`} fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            <span className={isPopular ? "text-blue-100" : "text-gray-300"}>{feat}</span>
          </li>
        ))}
      </ul>

      <Link href={`/order/${plan.id}`}>
        <button className="w-full py-2.5 rounded-xl font-semibold text-sm transition-all hover:opacity-90"
          style={isPopular
            ? { background: "#fff", color: "#1B4FE8" }
            : { background: "rgba(27,79,232,0.15)", color: "#93C5FD", border: "1px solid rgba(27,79,232,0.3)" }}>
          Get Started
        </button>
      </Link>
    </div>
  );
}

/* ── Price display block ── */
export function PriceBlock({
  monthlyPrice, originalPrice, totalPrice, cycle, hasDiscount, cycleLabel, isPopular, accent,
}: {
  monthlyPrice: number;
  originalPrice: number;
  totalPrice: number;
  cycle: BillingCycle;
  hasDiscount: boolean;
  cycleLabel: string;
  isPopular: boolean;
  accent: string;
}) {
  const dimColor = isPopular ? "rgba(219,234,254,0.7)" : "#6B7280";

  return (
    <div className="mb-6">
      {/* Crossed-out original price when discounted */}
      {hasDiscount && (
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm line-through" style={{ color: dimColor }}>
            ₹{originalPrice.toLocaleString("en-IN")}/mo
          </span>
          <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full"
            style={{ background: "rgba(16,185,129,0.15)", color: "#34D399" }}>
            {BILLING_OPTIONS.find(o => o.months === cycle)!.discount}% OFF
          </span>
        </div>
      )}

      {/* Current price */}
      <div className="flex items-end gap-1">
        <span className="text-4xl font-black text-white leading-none">
          ₹{monthlyPrice.toLocaleString("en-IN")}
        </span>
        <span className="text-sm mb-1" style={{ color: dimColor }}>/mo</span>
      </div>

      {/* Billing details */}
      {cycle === 1 ? (
        <p className="text-xs mt-1.5" style={{ color: dimColor }}>+ 18% GST · Billed monthly</p>
      ) : (
        <div className="mt-1.5 space-y-0.5">
          <p className="text-xs" style={{ color: accent }}>
            ₹{totalPrice.toLocaleString("en-IN")} billed {cycle === 12 ? "annually" : "every 2 years"} + GST
          </p>
          <p className="text-xs" style={{ color: dimColor }}>{cycleLabel}</p>
        </div>
      )}
    </div>
  );
}
