"use client";

import { useState } from "react";
import Link from "next/link";
import Navbar from "@/components/landing/Navbar";
import {
  type Plan,
  type BillingCycle,
  BILLING_OPTIONS,
  categoryLabel,
  getMonthlyPrice,
  PlanGrid,
} from "@/components/pricing/PlanCards";

const CATEGORIES = [
  { key: "ALL",        label: "All Plans",       icon: "✦" },
  { key: "SHARED",     label: "Shared",          icon: "🌐" },
  { key: "VPS",        label: "VPS",             icon: "🖥️" },
  { key: "WORDPRESS",  label: "WordPress",       icon: "📝" },
  { key: "STORAGE",    label: "Storage",         icon: "🗄️" },
  { key: "DEDICATED",  label: "Dedicated Server", icon: "⭐" },
];

export default function PricingClient({ plans }: { plans: Plan[] }) {
  const [active, setActive]   = useState("ALL");
  const [cycle, setCycle]     = useState<BillingCycle>(12);

  const filtered = plans.filter((p) => {
    if (active === "ALL")       return true;
    if (active === "DEDICATED") return p.category === "DEDICATED";
    return p.category === active && p.tier === "STANDARD";
  });

  const currentOpt = BILLING_OPTIONS.find(o => o.months === cycle)!;

  return (
    <div style={{ background: "linear-gradient(135deg, #0B1120 0%, #0F172A 50%, #0B1120 100%)", minHeight: "100vh" }}>
      <Navbar />

      {/* ── Header ── */}
      <section className="pt-12 pb-2 text-center px-4">
        <div className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium mb-5"
          style={{ background: "rgba(27,79,232,0.12)", border: "1px solid rgba(27,79,232,0.35)", color: "#93C5FD" }}>
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block" />
          All prices in INR · GST 18% added at checkout
        </div>
        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black text-white mb-3 tracking-tight">
          Simple, Transparent Pricing
        </h1>
        <p className="text-gray-400 text-base sm:text-lg max-w-lg mx-auto mb-8">
          No surprise bills. Cancel anytime. Instant setup.
        </p>

        {/* ── Billing cycle switcher ── */}
        <div className="inline-flex flex-col items-center gap-3">
          <div className="flex items-center p-1 gap-1 rounded-2xl"
            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }}>
            {BILLING_OPTIONS.map((opt) => {
              const isActive = cycle === opt.months;
              return (
                <button
                  key={opt.months}
                  onClick={() => setCycle(opt.months)}
                  className="relative flex flex-col items-center px-5 py-3 rounded-xl transition-all duration-200"
                  style={{
                    minWidth: 100,
                    background: isActive ? "linear-gradient(135deg, #1B4FE8, #0EA5E9)" : "transparent",
                    boxShadow: isActive ? "0 4px 20px rgba(27,79,232,0.4)" : "none",
                  }}
                >
                  <span className={`text-sm font-bold ${isActive ? "text-white" : "text-gray-300"}`}>
                    {opt.label}
                  </span>
                  <span className={`text-xs mt-0.5 ${isActive ? "text-blue-100" : "text-gray-500"}`}>
                    {opt.sublabel}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Discount note */}
          {cycle !== 1 && (
            <p className="text-xs mt-1" style={{ color: "#9CA3AF" }}>
              {currentOpt.discount}% off vs monthly · {currentOpt.sublabel}
            </p>
          )}
        </div>
      </section>

      {/* ── Filter bar ── */}
      <div className="sticky top-0 z-40 py-3 px-4 mt-8"
        style={{ background: "rgba(11,17,32,0.96)", backdropFilter: "blur(16px)", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5"
            style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}>
            {CATEGORIES.map((cat) => {
              const isSelected = active === cat.key;
              const count = cat.key === "ALL"        ? plans.length
                : cat.key === "DEDICATED"            ? plans.filter(p => p.category === "DEDICATED").length
                : plans.filter(p => p.category === cat.key && p.tier === "STANDARD").length;
              return (
                <button key={cat.key} onClick={() => setActive(cat.key)}
                  className="flex items-center gap-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-200 shrink-0"
                  style={{
                    padding: "7px 14px",
                    background: isSelected ? "linear-gradient(135deg, #1B4FE8, #0EA5E9)" : "rgba(255,255,255,0.04)",
                    border: isSelected ? "1px solid transparent" : "1px solid rgba(255,255,255,0.1)",
                    color: isSelected ? "#fff" : "#9CA3AF",
                    boxShadow: isSelected ? "0 4px 15px rgba(27,79,232,0.35)" : "none",
                  }}>
                  <span>{cat.icon}</span>
                  <span>{cat.label}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded-full"
                    style={{ background: isSelected ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.08)", color: isSelected ? "#fff" : "#6B7280" }}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Plans ── */}
      <section className="py-10 sm:py-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {filtered.length === 0 ? (
            <div className="text-center py-24 text-gray-500">No plans in this category.</div>
          ) : active === "ALL" ? (
            <div className="flex flex-col gap-16">
              {["SHARED", "VPS", "WORDPRESS", "STORAGE"].map((cat) => {
                const catPlans = plans.filter(p => p.category === cat && p.tier === "STANDARD");
                if (!catPlans.length) return null;
                return (
                  <div key={cat}>
                    <div className="flex items-center justify-between mb-6">
                      <div>
                        <h2 className="text-xl font-bold text-white">{categoryLabel[cat]}</h2>
                        <p className="text-gray-500 text-xs mt-0.5">
                          From ₹{getMonthlyPrice(Math.min(...catPlans.map(p => p.price)), cycle).toLocaleString("en-IN")}/mo
                          {cycle !== 1 && <span className="text-emerald-500 ml-1">· {currentOpt.discount}% off</span>}
                        </p>
                      </div>
                      <button onClick={() => setActive(cat)} className="text-sm font-medium hover:opacity-80 transition-colors" style={{ color: "#60A5FA" }}>
                        View all →
                      </button>
                    </div>
                    <PlanGrid plans={catPlans} cycle={cycle} />
                  </div>
                );
              })}
              {plans.filter(p => p.category === "DEDICATED").length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-6">
                    <div>
                      <div className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-3 py-1 mb-2"
                        style={{ background: "rgba(168,85,247,0.12)", border: "1px solid rgba(168,85,247,0.3)", color: "#C084FC" }}>
                        ⭐ Enterprise Grade
                      </div>
                      <h2 className="text-xl font-bold text-white">Dedicated Server Plans</h2>
                    </div>
                    <button onClick={() => setActive("DEDICATED")} className="text-sm font-medium hover:opacity-80 transition-colors" style={{ color: "#60A5FA" }}>
                      View all →
                    </button>
                  </div>
                  <PlanGrid plans={plans.filter(p => p.category === "DEDICATED")} cycle={cycle} premium />
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="mb-8">
                <h2 className="text-2xl font-bold text-white">
                  {active === "DEDICATED" ? "Dedicated Server Plans" : categoryLabel[active]}
                </h2>
                {active !== "DEDICATED" && filtered.length > 0 && (
                  <p className="text-gray-500 text-sm mt-1">
                    From ₹{getMonthlyPrice(Math.min(...filtered.map(p => p.price)), cycle).toLocaleString("en-IN")}/month
                    {cycle !== 1 && <span className="text-emerald-500 ml-1">· {currentOpt.discount}% off with {currentOpt.label} plan</span>}
                  </p>
                )}
              </div>
              <PlanGrid plans={filtered} cycle={cycle} premium={active === "DEDICATED"} />
            </>
          )}
        </div>
      </section>

      {/* ── Enterprise CTA ── */}
      <section className="pb-12 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="rounded-2xl p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <div>
              <h3 className="text-white font-bold text-lg mb-1">Need a custom plan?</h3>
              <p className="text-gray-400 text-sm">Unlimited resources, dedicated infra, SLA-backed uptime.</p>
            </div>
            <a href="mailto:sales@sowsicloud.com" className="shrink-0 px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-90"
              style={{ border: "1px solid rgba(255,255,255,0.15)", color: "#E2E8F0", whiteSpace: "nowrap" }}>
              Contact Sales →
            </a>
          </div>
        </div>
      </section>

      {/* ── Included in all plans ── */}
      <section className="pb-16 px-4 pt-12" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-xl font-bold text-white mb-8">Every plan includes</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { icon: "🔒", label: "Free SSL" },
              { icon: "🧾", label: "GST Invoice" },
              { icon: "💳", label: "UPI Payments" },
              { icon: "📞", label: "24/7 Support" },
              { icon: "🔄", label: "99.9% Uptime" },
              { icon: "🗓️", label: "Cancel Anytime" },
              { icon: "🇮🇳", label: "Indian Servers" },
              { icon: "⚡", label: "Instant Setup" },
            ].map((item) => (
              <div key={item.label} className="rounded-xl p-4 flex flex-col items-center gap-2"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                <span className="text-2xl">{item.icon}</span>
                <span className="text-gray-300 text-xs font-medium">{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
