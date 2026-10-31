"use client";

import Link from "next/link";
import {
  type CycleKey,
  type PublicPlan,
  CYCLES,
  CYCLE_KEYS,
  firstTermRate,
  savingsPercent,
  availableCycles,
  formatINR,
  formatStorage,
} from "@/lib/pricing";
import { SavePill } from "@/components/ui/selection";
import { UnavailablePlan } from "@/components/pricing/Unavailable";

export type { PublicPlan, CycleKey };

/* ── Billing cycle segmented control ── */
export function CyclePicker({
  plans,
  cycle,
  onChange,
}: {
  plans: PublicPlan[];
  cycle: CycleKey;
  onChange: (c: CycleKey) => void;
}) {
  const cycles = CYCLE_KEYS.filter((c) => plans.some((p) => availableCycles(p).includes(c)));
  return (
    <div
      className="inline-flex flex-wrap justify-center p-1 gap-1 rounded-xl bg-surface border border-line"
      role="radiogroup"
      aria-label="Billing cycle"
    >
      {cycles.map((c) => {
        const isActive = cycle === c;
        const best = Math.max(0, ...plans.map((p) => savingsPercent(p, c)));
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(c)}
            className={`flex flex-col items-center justify-center min-w-28 min-h-12 px-4 py-2 rounded-lg cursor-pointer transition-colors duration-150 ${
              isActive ? "bg-primary text-on-primary shadow-sm shadow-primary/30" : "text-fg-muted hover:text-fg hover:bg-surface-2"
            }`}
          >
            <span className="text-sm font-semibold">{CYCLES[c].label}</span>
            <span className={`text-xs font-medium ${isActive ? "text-blue-100" : best ? "text-success" : "text-fg-muted"}`}>
              {best ? `Save up to ${best}%` : "No commitment"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Plan card grid ── */
export function PlanGrid({ plans, cycle }: { plans: PublicPlan[]; cycle: CycleKey }) {
  return (
    <div
      className={`grid gap-5 grid-cols-1 ${plans.length >= 2 ? "md:grid-cols-2" : ""} ${
        plans.length === 3 ? "lg:grid-cols-3" : plans.length >= 4 ? "lg:grid-cols-4" : ""
      }`}
    >
      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} cycle={cycle} />
      ))}
    </div>
  );
}

const CHECK = (
  <svg className="w-4 h-4 shrink-0 mt-0.5 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

/** Feature bullets that only repeat a spec already shown in the spec grid. */
const SPEC_FEATURE = /\b(vcpu|ram|nvme|ssd|bandwidth)\b/i;

/** vCPU / RAM / disk / bandwidth tiles for VPS plans; empty for plans without specs. */
function specTiles(plan: PublicPlan) {
  return [
    plan.vcpu && { value: String(plan.vcpu), unit: plan.vcpu === 1 ? "vCPU" : "vCPUs" },
    plan.ramGB && { value: `${plan.ramGB} GB`, unit: "RAM" },
    plan.storageGB && { value: formatStorage(plan.storageGB), unit: "NVMe SSD" },
    plan.bandwidthTB && { value: `${plan.bandwidthTB} TB`, unit: "Bandwidth" },
  ].filter((t): t is { value: string; unit: string } => !!t);
}

/* ── Single plan card ── */
export function PlanCard({ plan, cycle: wanted }: { plan: PublicPlan; cycle: CycleKey }) {
  // Fall back to the plan's longest available cycle if it doesn't offer the selected one.
  const cycles = availableCycles(plan);
  const cycle = cycles.includes(wanted) ? wanted : cycles[cycles.length - 1];
  const rate = firstTermRate(plan, cycle, false) ?? 0;
  const save = savingsPercent(plan, cycle);
  const isStorage = plan.category === "STORAGE";
  const tiles = isStorage ? [] : specTiles(plan);
  const features = tiles.length ? plan.features.filter((f) => !SPEC_FEATURE.test(f)) : plan.features;

  return (
    <div
      className={`relative rounded-xl p-6 flex flex-col border transition-[border-color,box-shadow] duration-200 ease-out ${
        plan.isPopular
          ? "border-primary ring-1 ring-primary bg-primary/5"
          : "border-line bg-surface hover:border-line-strong"
      }`}
    >
      {plan.isPopular && (
        <span className="absolute -top-3 left-6 text-xs font-semibold px-2.5 py-0.5 rounded-full bg-primary text-on-primary">
          Most popular
        </span>
      )}

      <h3 className="text-lg font-semibold text-fg">{plan.name}</h3>
      {isStorage && plan.storageGB && (
        <p className="mt-1 text-sm text-fg-muted">
          <span className="font-mono text-fg">{formatStorage(plan.storageGB)}</span> object storage
        </p>
      )}

      {tiles.length > 0 && (
        <dl className="mt-4 grid grid-cols-2 gap-2">
          {tiles.map((t) => (
            <div key={t.unit} className="rounded-lg bg-canvas px-3 py-2">
              <dt className="sr-only">{t.unit}</dt>
              <dd>
                <span className="block font-mono text-base font-medium text-fg">{t.value}</span>
                <span className="block text-xs text-fg-muted">{t.unit}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-5">
        <div className="flex items-center gap-2 h-5">
          {save > 0 && plan.priceMonthly && (
            <>
              {/* Pay-monthly price, struck through to show the saving */}
              <s className="text-sm text-fg-muted line-through">
                <span className="sr-only">Monthly price </span>
                {formatINR(plan.priceMonthly)}/mo
              </s>
              <SavePill percent={save} />
            </>
          )}
        </div>
        <p className="flex items-baseline gap-1 mt-1">
          <span className="text-4xl font-bold text-fg tabular-nums tracking-tight">{formatINR(rate)}</span>
          <span className="text-fg-muted text-sm">/mo</span>
        </p>
        <p className="text-xs text-fg-muted mt-1 min-h-4">
          {cycle === "monthly"
            ? "Billed monthly · cancel anytime"
            : CYCLES[cycle].billed}
        </p>
      </div>

      {plan.orderable ? (
        <Link
          href={`/order/${plan.slug}?cycle=${cycle}`}
          className={`mt-5 flex items-center justify-center h-11 rounded-lg font-semibold text-sm transition-[background-color,border-color,transform] duration-150 ${
            plan.isPopular
              ? "bg-primary text-on-primary shadow-sm shadow-primary/30 hover:bg-primary-hover active:bg-primary-active active:translate-y-px"
              : "bg-surface border border-line-strong text-fg hover:border-fg-subtle hover:bg-surface-2 active:bg-canvas active:translate-y-px"
          }`}
        >
          {isStorage ? "Get" : "Deploy"} {plan.name}
        </Link>
      ) : (
        <UnavailablePlan />
      )}

      {features.length > 0 && (
        <ul className="mt-6 flex flex-col gap-2.5 border-t border-line pt-5">
          {features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-sm text-fg-muted">
              {CHECK}
              <span>{f}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Dedicated plans (gold tier marker; actions stay primary) ── */

const BUILDING_ICON =
  "M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4";

const PREMIUM_CHECK = (
  <svg className="w-4 h-4 shrink-0 mt-0.5 text-premium" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

export function DedicatedGrid({ plans, cycle }: { plans: PublicPlan[]; cycle: CycleKey }) {
  return (
    <div
      className={`grid gap-5 grid-cols-1 ${plans.length >= 2 ? "md:grid-cols-2" : ""} ${
        plans.length === 3 ? "lg:grid-cols-3" : plans.length >= 4 ? "xl:grid-cols-4" : ""
      }`}
    >
      {plans.map((plan) => (
        <DedicatedCard key={plan.id} plan={plan} cycle={cycle} />
      ))}
    </div>
  );
}

/** Flat monthly price, or a discounted 1/2-year term. */
export function DedicatedCard({ plan, cycle: wanted }: { plan: PublicPlan; cycle: CycleKey }) {
  const cycles = availableCycles(plan);
  const cycle = cycles.includes(wanted) ? wanted : cycles[cycles.length - 1];
  const price = firstTermRate(plan, cycle, false) ?? 0;
  const save = savingsPercent(plan, cycle);
  const isStorage = plan.category === "STORAGE";
  const tiles = isStorage ? [] : specTiles(plan);
  const features = tiles.length ? plan.features.filter((f) => !SPEC_FEATURE.test(f)) : plan.features;

  return (
    <div
      className={`relative rounded-xl p-6 flex flex-col border transition-[border-color,box-shadow] duration-200 ease-out ${
        plan.isPopular ? "border-premium ring-1 ring-premium bg-premium/5" : "border-premium/40 bg-surface hover:border-premium/70"
      }`}
    >
      {plan.isPopular && (
        <span className="absolute -top-3 left-6 text-xs font-semibold px-2.5 py-0.5 rounded-full bg-premium text-canvas">
          Most popular
        </span>
      )}

      <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-premium/30 bg-premium/10 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-premium">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d={BUILDING_ICON} />
        </svg>
        Dedicated
      </span>

      <h3 className="mt-3 text-lg font-semibold text-fg">{plan.name}</h3>
      {isStorage && plan.storageGB && (
        <p className="mt-1 text-sm text-fg-muted">
          <span className="font-mono text-fg">{formatStorage(plan.storageGB)}</span> dedicated storage
        </p>
      )}

      {tiles.length > 0 && (
        <dl className="mt-4 grid grid-cols-2 gap-2">
          {tiles.map((t) => (
            <div key={t.unit} className="rounded-lg bg-canvas px-3 py-2">
              <dt className="sr-only">{t.unit}</dt>
              <dd>
                <span className="block font-mono text-base font-medium text-fg">{t.value}</span>
                <span className="block text-xs text-fg-muted">{t.unit}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-5">
        <div className="flex items-center gap-2 h-5">
          {save > 0 && plan.priceMonthly && (
            <>
              {/* Pay-monthly price, struck through to show the saving */}
              <s className="text-sm text-fg-muted line-through">
                <span className="sr-only">Monthly price </span>
                {formatINR(plan.priceMonthly)}/mo
              </s>
              <SavePill percent={save} />
            </>
          )}
        </div>
        <p className="flex items-baseline gap-1 mt-1">
          <span className="text-4xl font-bold text-fg tabular-nums tracking-tight">{formatINR(price)}</span>
          <span className="text-fg-muted text-sm">/mo</span>
        </p>
        {cycle === "monthly" ? (
          <>
            <p className="text-sm text-fg mt-1">One flat monthly price.</p>
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-line-strong px-2.5 py-0.5 text-xs font-medium text-fg-muted">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              No renewal price shock
            </p>
          </>
        ) : (
          <p className="text-xs text-fg-muted mt-1">
            {CYCLES[cycle].billed}
          </p>
        )}
      </div>

      {plan.orderable ? (
        <Link
          href={`/order/${plan.slug}?cycle=${cycle}`}
          className={`mt-5 flex items-center justify-center h-11 rounded-lg font-semibold text-sm transition-[background-color,border-color,transform] duration-150 ${
            plan.isPopular
              ? "bg-primary text-on-primary shadow-sm shadow-primary/30 hover:bg-primary-hover active:bg-primary-active active:translate-y-px"
              : "bg-surface border border-line-strong text-fg hover:border-fg-subtle hover:bg-surface-2 active:bg-canvas active:translate-y-px"
          }`}
        >
          {isStorage ? "Get" : "Deploy"} {plan.name}
        </Link>
      ) : (
        <UnavailablePlan />
      )}

      {features.length > 0 && (
        <ul className="mt-6 flex flex-col gap-2.5 border-t border-line pt-5">
          {features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-sm text-fg-muted">
              {PREMIUM_CHECK}
              <span>{f}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
