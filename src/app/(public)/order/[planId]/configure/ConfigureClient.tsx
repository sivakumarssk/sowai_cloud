"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "@/components/landing/Navbar";
import { Button } from "@/components/ui/Button";
import { RadioDot, selectCardClass } from "@/components/ui/selection";
import { OrderSteps } from "@/components/order/OrderSteps";
import { OrderSummary, MobileOrderBar, PaymentNote } from "@/components/order/OrderSummary";
import { configureStepHref, planStepHref } from "@/lib/orderFlow";
import {
  REGIONS,
  DEFAULT_REGION,
  OS_IMAGES,
  getOsImage,
  getPresetsForCategory,
  hostnameError,
  normalizeHostname,
} from "@/lib/provisioning/catalog";
import { type CycleKey, type PricedAddon, type PublicPlan, quotePrice, resolveAddons } from "@/lib/pricing";

export default function ConfigureClient({
  plan,
  addons,
  returning,
  cycle,
  chosenAddonSlugs,
  initialHostname,
  initialStack,
  initialOs,
}: {
  plan: PublicPlan;
  addons: PricedAddon[];
  returning: boolean;
  cycle: CycleKey;
  chosenAddonSlugs: string[];
  initialHostname: string;
  initialStack: string;
  initialOs: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const isStorage = plan.category === "STORAGE";
  const nameKind = isStorage ? "Bucket name" : "Hostname";

  const chosenAddons = resolveAddons(addons, chosenAddonSlugs, plan.category);
  const quote = quotePrice(plan, cycle, chosenAddons, { returning });
  const presets = getPresetsForCategory(plan.category);
  const region = REGIONS.find((r) => r.value === DEFAULT_REGION)!;

  const [stackPreset, setStackPreset] = useState(initialStack);
  const [osImage, setOsImage] = useState(initialOs);
  const [hostname, setHostname] = useState(normalizeHostname(initialHostname));
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const activePreset = presets.find((p) => p.value === stackPreset) || presets[0];
  const lockedOs = activePreset?.lockedOs ?? null;
  const nameError = hostnameError(hostname, nameKind);
  const showNameError = touched && !!nameError;

  // Mirror choices into the URL so Back from checkout (or a refresh) keeps them.
  function sync(next: { hostname?: string; stack?: string; os?: string }) {
    const choices = {
      cycle,
      addons: chosenAddonSlugs,
      hostname: next.hostname ?? hostname,
      stack: next.stack ?? stackPreset,
      os: next.os ?? osImage,
    };
    window.history.replaceState(null, "", configureStepHref(plan.slug, choices));
  }

  async function handleContinue() {
    setSubmitError(null);
    setTouched(true);
    if (nameError) {
      inputRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/orders/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId: plan.id,
          billingCycle: cycle,
          addons: chosenAddons.map((a) => a.slug),
          region: region.value,
          osImage: lockedOs || osImage,
          stackPreset: activePreset?.value,
          hostname,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setSubmitError(data.error || "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      router.push(`/order/${plan.slug}/checkout?orderId=${data.data.orderId}`);
    } catch {
      setSubmitError("Couldn't reach Sowsi Cloud. Check your connection and try again.");
      setSubmitting(false);
    }
  }

  const planHref = planStepHref(plan.slug, { cycle, addons: chosenAddonSlugs });

  return (
    <div className="min-h-screen bg-canvas pb-24 lg:pb-0">
      <Navbar />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
        <OrderSteps current="Configure" hrefs={{ Plan: planHref }} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 flex flex-col gap-8">
            <div>
              <h1 className="text-2xl font-semibold text-fg">{isStorage ? "Set up your storage" : "Configure your server"}</h1>
              <p className="text-fg-muted text-sm mt-1">
                {isStorage ? "Give your bucket a name." : "Name your server and choose what to install."}
              </p>
            </div>

            {/* Hostname — the one required field goes first */}
            <section>
              <label htmlFor="hostname" className="block text-fg font-semibold text-lg mb-1">
                {nameKind}
              </label>
              <p id="hostname-help" className="text-sm text-fg-muted mb-3">
                Lowercase letters, numbers and hyphens.
              </p>
              <input
                ref={inputRef}
                id="hostname"
                type="text"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={63}
                value={hostname}
                onChange={(e) => {
                  const v = e.target.value.toLowerCase().replace(/\s+/g, "-");
                  setHostname(v);
                  sync({ hostname: v });
                }}
                onBlur={() => hostname && setTouched(true)}
                placeholder={isStorage ? "my-app-assets" : "my-app-server"}
                aria-invalid={showNameError}
                aria-describedby={showNameError ? "hostname-error hostname-help" : "hostname-help"}
                className={`w-full sm:max-w-md h-11 px-3.5 rounded-lg font-mono text-sm text-fg bg-canvas border placeholder:text-fg-subtle focus:outline-none transition-colors duration-150 ${
                  showNameError ? "border-danger focus:border-danger" : "border-line-strong focus:border-link"
                }`}
              />
              {showNameError && (
                <p id="hostname-error" className="flex items-center gap-1.5 text-sm text-danger mt-2">
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {nameError}
                </p>
              )}
            </section>

            {/* Server type */}
            {!isStorage && presets.length > 1 && (
              <section aria-labelledby="stack-heading">
                <h2 id="stack-heading" className="text-fg font-semibold text-lg mb-3">
                  What should we install?
                </h2>
                <div role="radiogroup" aria-labelledby="stack-heading" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {presets.map((p) => {
                    const isSelected = stackPreset === p.value;
                    return (
                      <button
                        key={p.value}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => {
                          setStackPreset(p.value);
                          sync({ stack: p.value });
                        }}
                        className={selectCardClass(isSelected)}
                      >
                        <span className="flex items-center gap-2.5 mb-1">
                          <RadioDot checked={isSelected} />
                          <span className="text-sm font-semibold text-fg">{p.label}</span>
                        </span>
                        <span className="block text-xs text-fg-muted pl-7">{p.description}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* OS image */}
            {!isStorage && (
              <section aria-labelledby="os-heading">
                <h2 id="os-heading" className="text-fg font-semibold text-lg mb-3">
                  Operating system
                </h2>
                {lockedOs ? (
                  <div className="rounded-xl bg-surface border border-line p-4">
                    <p className="text-fg text-sm font-medium">{getOsImage(lockedOs)?.label}</p>
                    <p className="text-fg-muted text-xs mt-1">Included with {activePreset?.label}.</p>
                  </div>
                ) : (
                  <div role="radiogroup" aria-labelledby="os-heading" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {OS_IMAGES.map((os) => {
                      const isSelected = osImage === os.value;
                      return (
                        <button
                          key={os.value}
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          onClick={() => {
                            setOsImage(os.value);
                            sync({ os: os.value });
                          }}
                          className={`${selectCardClass(isSelected)} flex items-center gap-2.5`}
                        >
                          <RadioDot checked={isSelected} />
                          <span className="text-sm font-medium text-fg">{os.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {/* Location — one region for now, so state it rather than show a disabled picker */}
            <section aria-labelledby="region-heading">
              <h2 id="region-heading" className="text-fg font-semibold text-lg mb-3">
                Location
              </h2>
              <div className="rounded-xl bg-surface border border-line p-4 flex items-center gap-3">
                <svg className="w-5 h-5 text-link shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <p className="text-sm font-medium text-fg">{region.label}</p>
              </div>
            </section>

            {/* Add-ons (chosen on the plan step) */}
            <section aria-labelledby="addons-heading">
              <div className="flex items-center justify-between mb-3">
                <h2 id="addons-heading" className="text-fg font-semibold text-lg">
                  Add-ons
                </h2>
                <Link href={planHref} className="text-sm font-medium text-link hover:underline">
                  Change
                </Link>
              </div>
              {chosenAddons.length === 0 ? (
                <p className="text-sm text-fg-muted">None selected.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {chosenAddons.map((a) => (
                    <li key={a.slug} className="text-sm rounded-lg bg-surface border border-line px-4 py-3 text-fg">
                      {a.name}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {submitError && (
              <p role="alert" className="lg:hidden text-sm text-danger rounded-lg bg-danger/10 border border-danger/30 px-3 py-2.5">
                {submitError}
              </p>
            )}
          </div>

          {/* ── Summary ── */}
          <aside className="lg:col-span-1" aria-label="Order summary">
            <div className="lg:sticky lg:top-24">
              <OrderSummary planName={plan.name} quote={quote}>
                {submitError && (
                  <p role="alert" className="hidden lg:block mt-5 text-sm text-danger rounded-lg bg-danger/10 border border-danger/30 px-3 py-2.5">
                    {submitError}
                  </p>
                )}
                <Button size="lg" className="w-full mt-5" onClick={handleContinue} loading={submitting}>
                  Continue to payment
                </Button>
                <PaymentNote />
              </OrderSummary>
            </div>
          </aside>
        </div>
      </div>

      <MobileOrderBar total={quote.total}>
        <Button size="lg" onClick={handleContinue} loading={submitting}>
          Continue to payment
        </Button>
      </MobileOrderBar>
    </div>
  );
}
