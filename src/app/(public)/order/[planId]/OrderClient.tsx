"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "@/components/landing/Navbar";
import { Button } from "@/components/ui/Button";
import { RadioDot, SavePill, Toggle, selectCardClass } from "@/components/ui/selection";
import { OrderSteps } from "@/components/order/OrderSteps";
import { OrderSummary, MobileOrderBar, PaymentNote } from "@/components/order/OrderSummary";
import { useAuthStore } from "@/store/authStore";
import { configureStepHref, planStepHref } from "@/lib/orderFlow";
import {
  type CycleKey,
  type PricedAddon,
  type PublicPlan,
  CYCLES,
  availableCycles,
  categoryLabel,
  firstTermRate,
  formatINR,
  formatStorage,
  quotePrice,
  resolveAddons,
  savingsPercent,
} from "@/lib/pricing";

export default function OrderClient({
  plan,
  addons,
  initialCycle,
  initialAddons,
  returning,
}: {
  plan: PublicPlan;
  addons: PricedAddon[];
  initialCycle: CycleKey;
  initialAddons: string[];
  returning: boolean;
}) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [cycle, setCycle] = useState<CycleKey>(initialCycle);
  const [selected, setSelected] = useState<string[]>(initialAddons);
  const [navigating, setNavigating] = useState(false);

  const cycles = availableCycles(plan);
  const chosenAddons = resolveAddons(addons, selected, plan.category);
  const quote = quotePrice(plan, cycle, chosenAddons, { returning });
  // Returning customers lose intro prices, but dedicated term discounts apply to everyone.
  const introLost = returning && !plan.isDedicated;
  const specs = [
    plan.vcpu && `${plan.vcpu} vCPU`,
    plan.ramGB && `${plan.ramGB} GB RAM`,
    plan.storageGB && (plan.category === "STORAGE" ? formatStorage(plan.storageGB) : `${plan.storageGB} GB NVMe`),
    plan.bandwidthTB && `${plan.bandwidthTB} TB bandwidth`,
  ].filter(Boolean) as string[];

  // Keep the URL shareable / correct on refresh and when coming back from configure.
  function syncUrl(nextCycle: CycleKey, nextAddons: string[]) {
    window.history.replaceState(null, "", planStepHref(plan.slug, { cycle: nextCycle, addons: nextAddons }));
  }

  function chooseCycle(c: CycleKey) {
    setCycle(c);
    syncUrl(c, selected);
  }

  function toggleAddon(slug: string) {
    // resolveAddons drops the other member of an exclusive group (daily vs weekly backup).
    const next = selected.includes(slug)
      ? selected.filter((s) => s !== slug)
      : resolveAddons(addons, [...selected, slug], plan.category).map((a) => a.slug);
    setSelected(next);
    syncUrl(cycle, next);
  }

  function handleContinue() {
    setNavigating(true);
    const nextPath = configureStepHref(plan.slug, { cycle, addons: selected });
    router.push(user ? nextPath : `/login?redirect=${encodeURIComponent(nextPath)}`);
  }

  const continueLabel = user ? "Continue to configure" : "Sign in to continue";

  return (
    <div className="min-h-screen bg-canvas pb-24 lg:pb-0">
      <Navbar />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
        <OrderSteps current="Plan" />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* ── Choices ── */}
          <div className="lg:col-span-2 flex flex-col gap-8">
            {/* Selected plan */}
            <section className="rounded-xl bg-surface border border-line p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-link mb-1">{categoryLabel[plan.category] ?? plan.category}</p>
                  <h1 className="text-2xl font-semibold text-fg">{plan.name}</h1>
                  {specs.length > 0 && (
                    <p className="font-mono text-sm text-fg-muted mt-1.5">{specs.join(" · ")}</p>
                  )}
                </div>
                <Link href="/pricing" className="text-sm font-medium text-link hover:underline shrink-0">
                  Change plan
                </Link>
              </div>
            </section>

            {/* Billing cycle */}
            <section aria-labelledby="cycle-heading">
              <h2 id="cycle-heading" className="text-fg font-semibold text-lg mb-4">
                Billing cycle
              </h2>
              {introLost && (
                <p className="text-sm text-fg-muted -mt-2 mb-4">You&apos;ve had this plan before, so the renewal price applies.</p>
              )}
              <div
                role="radiogroup"
                aria-labelledby="cycle-heading"
                className={`grid grid-cols-1 gap-3 ${cycles.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
              >
                {cycles.map((c) => {
                  const isSelected = cycle === c;
                  const rate = firstTermRate(plan, c, returning) ?? 0;
                  const save = introLost ? 0 : savingsPercent(plan, c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => chooseCycle(c)}
                      role="radio"
                      aria-checked={isSelected}
                      className={`relative ${selectCardClass(isSelected)}`}
                    >
                      <span className="flex items-center justify-between gap-2 mb-2">
                        <span className="flex items-center gap-2.5">
                          <RadioDot checked={isSelected} />
                          <span className="text-sm font-semibold text-fg">{CYCLES[c].label}</span>
                        </span>
                        {save > 0 && <SavePill percent={save} />}
                      </span>
                      <span className="block pl-7">
                        <span className="text-2xl font-bold text-fg tabular-nums">{formatINR(rate)}</span>
                        <span className="text-fg-muted text-xs">/mo</span>
                        <span className="block text-xs text-fg-muted mt-1">
                          {CYCLES[c].billed}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Add-ons */}
            {addons.length > 0 && (
              <section aria-labelledby="addons-heading">
                <h2 id="addons-heading" className="text-fg font-semibold text-lg mb-4">
                  Add-ons <span className="text-fg-muted font-normal text-sm">· optional</span>
                </h2>
                <div className="flex flex-col gap-3">
                  {addons.map((addon) => {
                    const isOn = selected.includes(addon.slug);
                    const rival = addon.exclusiveGroup
                      ? addons.find((a) => a.slug !== addon.slug && a.exclusiveGroup === addon.exclusiveGroup)
                      : undefined;
                    return (
                      <button
                        key={addon.slug}
                        type="button"
                        onClick={() => toggleAddon(addon.slug)}
                        role="switch"
                        aria-checked={isOn}
                        className={`${selectCardClass(isOn)} flex items-center gap-4 w-full`}
                      >
                        <Toggle on={isOn} />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-semibold text-fg">{addon.name}</span>
                          <span className="block text-xs text-fg-muted mt-0.5">{addon.description}</span>
                          {rival && (
                            <span className="block text-xs text-fg-muted mt-1">Replaces {rival.name}</span>
                          )}
                        </span>
                        <span className="text-right shrink-0">
                          <span className="block text-sm font-semibold text-fg tabular-nums">{formatINR(addon.priceMonthly)}</span>
                          <span className="block text-xs text-fg-muted">/month</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
          </div>

          {/* ── Summary ── */}
          <aside className="lg:col-span-1" aria-label="Order summary">
            <div className="lg:sticky lg:top-24">
              <OrderSummary planName={plan.name} quote={quote}>
                <Button size="lg" className="w-full mt-5" onClick={handleContinue} loading={navigating}>
                  {continueLabel}
                </Button>
                <PaymentNote />
              </OrderSummary>
            </div>
          </aside>
        </div>
      </div>

      <MobileOrderBar total={quote.total}>
        <Button size="lg" onClick={handleContinue} loading={navigating}>
          {user ? "Continue" : "Sign in to continue"}
        </Button>
      </MobileOrderBar>
    </div>
  );
}
