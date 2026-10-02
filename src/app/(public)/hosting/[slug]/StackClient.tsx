"use client";

import { useState } from "react";
import Link from "next/link";
import Navbar from "@/components/landing/Navbar";
import { type Plan, type BillingCycle, BILLING_OPTIONS, PlanGrid } from "@/components/pricing/PlanCards";
import type { HostingStack } from "@/lib/hostingStacks";

export default function StackClient({ stack, plans }: { stack: HostingStack; plans: Plan[] }) {
  const [cycle, setCycle] = useState<BillingCycle>(12);
  const premium = stack.category === "DEDICATED";

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: stack.faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  return (
    <div style={{ background: "linear-gradient(135deg, #0B1120 0%, #0F172A 50%, #0B1120 100%)", minHeight: "100vh" }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <Navbar />

      {/* ── Hero ── */}
      <section className="pt-14 pb-8 text-center px-4">
        <div className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium mb-5"
          style={{ background: "rgba(27,79,232,0.12)", border: "1px solid rgba(27,79,232,0.35)", color: "#93C5FD" }}>
          <span className="text-base">{stack.icon}</span>
          {stack.name}
        </div>
        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black text-white mb-3 tracking-tight max-w-3xl mx-auto">
          {stack.tagline}
        </h1>
        <p className="text-gray-400 text-base sm:text-lg max-w-2xl mx-auto">
          {stack.intro}
        </p>
      </section>

      {/* ── Billing cycle switcher ── */}
      <section className="pb-2 text-center px-4">
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
        </div>
      </section>

      {/* ── Plans ── */}
      <section className="py-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {plans.length === 0 ? (
            <div className="text-center py-16 text-gray-500">Plans coming soon for this category.</div>
          ) : (
            <PlanGrid plans={plans} cycle={cycle} premium={premium} />
          )}
        </div>
      </section>

      {/* ── Highlights ── */}
      <section className="py-10 px-4" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-6 text-center">Why {stack.name}?</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {stack.highlights.map((h) => (
              <div key={h} className="flex items-start gap-3 rounded-xl p-4"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                <svg className="w-5 h-5 shrink-0 mt-0.5 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                <span className="text-gray-300 text-sm">{h}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section className="py-10 px-4" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-6 text-center">Frequently Asked Questions</h2>
          <div className="flex flex-col gap-3">
            {stack.faqs.map((f) => (
              <details key={f.q} className="rounded-xl p-4 group"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                <summary className="text-white font-medium text-sm cursor-pointer list-none flex items-center justify-between">
                  {f.q}
                  <span className="text-gray-500 group-open:rotate-45 transition-transform">+</span>
                </summary>
                <p className="text-gray-400 text-sm mt-3">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="pb-16 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="rounded-2xl p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <div>
              <h3 className="text-white font-bold text-lg mb-1">Need a custom {stack.name.toLowerCase()} setup?</h3>
              <p className="text-gray-400 text-sm">Talk to our team about custom resources and migration support.</p>
            </div>
            <div className="flex gap-3 shrink-0">
              <Link href="/pricing" className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-90"
                style={{ border: "1px solid rgba(255,255,255,0.15)", color: "#E2E8F0", whiteSpace: "nowrap" }}>
                View All Plans
              </Link>
              <a href="mailto:sales@sowsicloud.com" className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90"
                style={{ background: "linear-gradient(135deg, #1B4FE8, #0EA5E9)", whiteSpace: "nowrap" }}>
                Contact Sales
              </a>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
