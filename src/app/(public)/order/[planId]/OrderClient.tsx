"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "@/components/landing/Navbar";
import { useAuthStore } from "@/store/authStore";

type PlanData = {
  id: string;
  name: string;
  category: string;
  tier: string;
  price: number;
  features: Record<string, string>;
};

type BillingOption = {
  months: number;
  label: string;
  discount: number;
  tag: string;
};

const BILLING_OPTIONS: BillingOption[] = [
  { months: 1,  label: "1 Month",   discount: 0,  tag: "" },
  { months: 6,  label: "6 Months",  discount: 10, tag: "Save 10%" },
  { months: 12, label: "12 Months", discount: 20, tag: "Save 20%" },
];

type Addon = {
  id: string;
  name: string;
  description: string;
  price: number;
  icon: string;
};

const ADDONS: Addon[] = [
  { id: "coolify",  name: "Coolify Panel",   description: "One-click app deployment panel", price: 99,  icon: "🚀" },
  { id: "backups",  name: "Daily Backups",   description: "Automated daily backups with 30-day retention", price: 199, icon: "💾" },
  { id: "extra-ip", name: "Extra IP Address", description: "Additional dedicated IPv4 address", price: 149, icon: "🌐" },
];

const categoryLabel: Record<string, string> = {
  SHARED: "Shared Hosting",
  VPS: "VPS Hosting",
  WORDPRESS: "WordPress Hosting",
  STORAGE: "Object Storage",
  DEDICATED: "Dedicated Server",
};

export default function OrderClient({ plan }: { plan: PlanData }) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [selectedBilling, setSelectedBilling] = useState(12);
  const [enabledAddons, setEnabledAddons] = useState<Set<string>>(new Set());

  const billing = BILLING_OPTIONS.find(b => b.months === selectedBilling)!;

  // Plan price per month after discount
  const planMonthly = Math.round(plan.price * (1 - billing.discount / 100));
  const planTotal = planMonthly * billing.months;

  // Addon totals
  const addonMonthly = ADDONS.filter(a => enabledAddons.has(a.id)).reduce((s, a) => s + a.price, 0);
  const addonTotal = addonMonthly * billing.months;

  const subtotal = planTotal + addonTotal;
  const gst = Math.round(subtotal * 0.18);
  const total = subtotal + gst;

  function toggleAddon(id: string) {
    setEnabledAddons(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleContinue() {
    const addons = Array.from(enabledAddons).join(",");
    const nextPath = `/order/${plan.id}/configure?cycle=${selectedBilling}${addons ? `&addons=${addons}` : ""}`;
    if (!user) {
      router.push(`/login?redirect=${encodeURIComponent(nextPath)}`);
      return;
    }
    router.push(nextPath);
  }

  const featureList = Object.values(plan.features);

  return (
    <div style={{ background: "linear-gradient(135deg, #0B1120 0%, #0F172A 50%, #0B1120 100%)", minHeight: "100vh" }}>
      <Navbar />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12">

        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm mb-8">
          <Link href="/pricing" className="text-gray-500 hover:text-gray-300 transition-colors">Pricing</Link>
          <span className="text-gray-600">→</span>
          <span className="text-white font-medium">{plan.name}</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

          {/* ── LEFT SIDE ── */}
          <div className="lg:col-span-2 flex flex-col gap-8">

            {/* Selected plan card */}
            <div className="rounded-2xl p-6" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                  <p className="text-xs font-medium mb-1" style={{ color: "#60A5FA" }}>
                    {categoryLabel[plan.category] ?? plan.category}
                    {plan.tier === "PREMIUM" && <span className="ml-2 text-purple-400">· Premium</span>}
                  </p>
                  <h2 className="text-2xl font-bold text-white">{plan.name}</h2>
                </div>
                <Link href="/pricing" className="text-sm font-medium shrink-0 transition-colors hover:opacity-80" style={{ color: "#60A5FA" }}>
                  Change plan
                </Link>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {featureList.map(feat => (
                  <div key={feat} className="flex items-center gap-2 text-sm">
                    <svg className="w-3.5 h-3.5 shrink-0" fill="currentColor" viewBox="0 0 20 20" style={{ color: "#34D399" }}>
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    <span className="text-gray-400 text-xs">{feat}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Billing cycle selector */}
            <div>
              <h3 className="text-white font-semibold text-lg mb-4">Billing Cycle</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {BILLING_OPTIONS.map(opt => {
                  const isSelected = selectedBilling === opt.months;
                  const monthly = Math.round(plan.price * (1 - opt.discount / 100));
                  return (
                    <button
                      key={opt.months}
                      onClick={() => setSelectedBilling(opt.months)}
                      className="relative rounded-xl p-4 text-left transition-all duration-200"
                      style={{
                        background: isSelected ? "rgba(27,79,232,0.12)" : "rgba(255,255,255,0.03)",
                        border: isSelected ? "2px solid #1B4FE8" : "1px solid rgba(255,255,255,0.08)",
                        boxShadow: isSelected ? "0 0 20px rgba(27,79,232,0.15)" : "none",
                      }}
                    >
                      {/* Discount tag */}
                      {opt.tag && (
                        <span className="absolute -top-2.5 right-3 text-[10px] font-bold px-2 py-0.5 rounded-full"
                          style={{ background: "#059669", color: "#fff" }}>
                          {opt.tag}
                        </span>
                      )}

                      <div className="flex items-center gap-3 mb-2">
                        {/* Radio circle */}
                        <div className="w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0"
                          style={{ borderColor: isSelected ? "#1B4FE8" : "rgba(255,255,255,0.2)" }}>
                          {isSelected && <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#1B4FE8" }} />}
                        </div>
                        <span className={`text-sm font-semibold ${isSelected ? "text-white" : "text-gray-300"}`}>
                          {opt.label}
                        </span>
                      </div>

                      <div className="ml-8">
                        <div className="flex items-end gap-1">
                          <span className="text-2xl font-black text-white">₹{monthly.toLocaleString("en-IN")}</span>
                          <span className="text-gray-500 text-xs mb-1">/mo</span>
                        </div>
                        {opt.months > 1 && (
                          <p className="text-xs mt-1" style={{ color: "#6B7280" }}>
                            ₹{(monthly * opt.months).toLocaleString("en-IN")} billed {opt.months === 6 ? "every 6 months" : "annually"}
                          </p>
                        )}
                        {opt.discount > 0 && (
                          <p className="text-xs mt-0.5 line-through" style={{ color: "#4B5563" }}>
                            ₹{plan.price.toLocaleString("en-IN")}/mo without discount
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Addons */}
            <div>
              <h3 className="text-white font-semibold text-lg mb-4">Add-ons</h3>
              <div className="flex flex-col gap-3">
                {ADDONS.map(addon => {
                  const isOn = enabledAddons.has(addon.id);
                  return (
                    <button
                      key={addon.id}
                      onClick={() => toggleAddon(addon.id)}
                      className="rounded-xl p-4 flex items-center gap-4 text-left transition-all duration-200 w-full"
                      style={{
                        background: isOn ? "rgba(27,79,232,0.08)" : "rgba(255,255,255,0.03)",
                        border: isOn ? "1px solid rgba(27,79,232,0.4)" : "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      {/* Toggle */}
                      <div className="w-11 h-6 rounded-full p-0.5 transition-colors shrink-0"
                        style={{ background: isOn ? "#1B4FE8" : "rgba(255,255,255,0.1)" }}>
                        <div className="w-5 h-5 rounded-full bg-white transition-transform"
                          style={{ transform: isOn ? "translateX(20px)" : "translateX(0)" }} />
                      </div>

                      {/* Icon */}
                      <span className="text-2xl shrink-0">{addon.icon}</span>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-semibold ${isOn ? "text-white" : "text-gray-300"}`}>{addon.name}</p>
                        <p className="text-xs text-gray-500">{addon.description}</p>
                      </div>

                      {/* Price */}
                      <div className="text-right shrink-0">
                        <p className="text-sm font-bold text-white">₹{addon.price.toLocaleString("en-IN")}</p>
                        <p className="text-xs text-gray-500">/month</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ── RIGHT SIDE — Order Summary (sticky) ── */}
          <div className="lg:col-span-1">
            <div className="lg:sticky lg:top-20">
              <div className="rounded-2xl p-6" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}>
                <h3 className="text-white font-bold text-lg mb-5">Order Summary</h3>

                {/* Plan line */}
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div>
                    <p className="text-sm text-white font-medium">{plan.name}</p>
                    <p className="text-xs text-gray-500">
                      ₹{planMonthly.toLocaleString("en-IN")}/mo × {billing.months} {billing.months === 1 ? "month" : "months"}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-white shrink-0">
                    ₹{planTotal.toLocaleString("en-IN")}
                  </span>
                </div>

                {billing.discount > 0 && (
                  <p className="text-xs mb-3" style={{ color: "#34D399" }}>
                    {billing.discount}% annual discount applied
                  </p>
                )}

                {/* Addon lines */}
                {ADDONS.filter(a => enabledAddons.has(a.id)).map(addon => (
                  <div key={addon.id} className="flex items-center justify-between py-2"
                    style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                    <div>
                      <p className="text-sm text-gray-300">{addon.name}</p>
                      <p className="text-xs text-gray-500">₹{addon.price.toLocaleString("en-IN")}/mo × {billing.months}</p>
                    </div>
                    <span className="text-sm text-white font-medium">
                      ₹{(addon.price * billing.months).toLocaleString("en-IN")}
                    </span>
                  </div>
                ))}

                {/* Totals */}
                <div className="mt-4 pt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.1)" }}>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-gray-400">Subtotal</span>
                    <span className="text-white font-medium">₹{subtotal.toLocaleString("en-IN")}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-3">
                    <span className="text-gray-400">GST (18%)</span>
                    <span className="text-white font-medium">₹{gst.toLocaleString("en-IN")}</span>
                  </div>
                  <div className="flex justify-between pt-3" style={{ borderTop: "1px solid rgba(255,255,255,0.1)" }}>
                    <span className="text-white font-bold text-lg">Total</span>
                    <span className="text-white font-black text-xl">₹{total.toLocaleString("en-IN")}</span>
                  </div>
                </div>

                {/* Per month breakdown */}
                {billing.months > 1 && (
                  <p className="text-xs text-gray-500 text-right mt-1">
                    ≈ ₹{Math.round(total / billing.months).toLocaleString("en-IN")}/month incl. GST
                  </p>
                )}

                {/* CTA */}
                <button
                  onClick={handleContinue}
                  className="w-full mt-6 py-3.5 rounded-xl font-semibold text-white text-sm transition-all hover:opacity-90 active:scale-[0.98]"
                  style={{ background: "linear-gradient(135deg, #1B4FE8, #0EA5E9)", boxShadow: "0 4px 20px rgba(27,79,232,0.35)" }}>
                  Continue to Payment
                </button>

                {/* Trust badges */}
                <div className="flex items-center justify-center gap-4 mt-4">
                  {[
                    { icon: "🔒", label: "SSL" },
                    { icon: "🧾", label: "GST Invoice" },
                    { icon: "💳", label: "UPI" },
                  ].map(b => (
                    <div key={b.label} className="flex items-center gap-1 text-gray-600 text-[10px]">
                      <span>{b.icon}</span>{b.label}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
