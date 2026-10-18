"use client";

import { useState } from "react";
import Link from "next/link";
import Navbar from "@/components/landing/Navbar";
import { type CycleKey, type PublicPlan, CyclePicker, PlanGrid, DedicatedGrid } from "@/components/pricing/PlanCards";
import {
  PROCESSING_FEE_PERCENT,
  GST_PERCENT,
  CYCLES,
  availableCycles,
  firstTermRate,
  renewalRate,
  formatINR,
  formatStorage,
} from "@/lib/pricing";
import { OS_IMAGES, REGIONS, getPresetsForCategory } from "@/lib/provisioning/catalog";

type Tab = "VPS" | "STORAGE" | "DEDICATED";

const TABS: { key: Tab; label: string; query: string }[] = [
  { key: "VPS", label: "VPS Hosting", query: "vps" },
  { key: "STORAGE", label: "Object Storage", query: "storage" },
  { key: "DEDICATED", label: "Dedicated", query: "dedicated" },
];

const HEADLINES: Record<Tab, { title: string; sub: string }> = {
  VPS: { title: "Linux VPS with full root access", sub: "NVMe SSD, a dedicated IPv4 and your choice of OS." },
  STORAGE: { title: "S3-compatible object storage", sub: "Store backups, media and app assets." },
  DEDICATED: {
    title: "Dedicated servers and storage",
    sub: "Guaranteed resources at one flat monthly price.",
  },
};

/** Sales WhatsApp, digits with country code (e.g. 919876543210). Unset → email only. */
const SALES_WHATSAPP = (process.env.NEXT_PUBLIC_SALES_WHATSAPP ?? "").replace(/\D/g, "");

function formatPhone(digits: string): string {
  return digits.startsWith("91") && digits.length === 12
    ? `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`
    : `+${digits}`;
}

// S4 has no cycle toggle: cards show the 1-year intro offer.
const STORAGE_CYCLE: CycleKey = "1year";

const regionNames = REGIONS.map((r) => r.label.replace(/^.*—\s*/, "")).join(", ");
const osNames = OS_IMAGES.map((o) => o.label.replace(" (Recommended)", "")).join(", ");
const stackNames = getPresetsForCategory("VPS")
  .filter((p) => p.value !== "plain")
  .map((p) => p.label)
  .join(", ");

/* Heroicons-outline paths for the "every plan includes" grid. */
const INCLUDED: { label: string; detail: string; icon: string }[] = [
  {
    label: "Full root SSH",
    detail: "Install anything, your way",
    icon: "M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
  },
  {
    label: "Dedicated IPv4",
    detail: "Your own public address",
    icon: "M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9",
  },
  {
    label: "NVMe SSD",
    detail: "Fast local storage",
    icon: "M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4",
  },
  {
    label: "OS or app stack",
    detail: "Ubuntu, Debian, Node.js, Python…",
    icon: "M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z",
  },
  {
    label: "Free SSL",
    detail: "HTTPS for your domains",
    icon: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z",
  },
  {
    label: "Secure & trusted payments",
    detail: "UPI, cards, netbanking",
    icon: "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z",
  },
  {
    label: "Autopay, cancel anytime",
    detail: "Turn it off from your dashboard",
    icon: "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15",
  },
  {
    label: "99.9% uptime",
    detail: "Monitored around the clock",
    icon: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z",
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "What's the difference between the intro and renewal price?",
    a: "The intro price is for your first 1- or 2-year term as a new customer. After that, autopay renews monthly at the renewal price.",
  },
  {
    q: "How does billing and autopay work?",
    a: "You pay the first term at checkout and set up autopay with UPI, a card or netbanking. Cancel anytime from your dashboard; your server runs until the paid period ends.",
  },
  {
    q: `What are the ${PROCESSING_FEE_PERCENT}% charges?`,
    a: `Payment gateway charges, shown before you pay.${
      GST_PERCENT > 0 ? ` GST at ${GST_PERCENT}% is also added.` : ""
    } Nothing else is added.`,
  },
  {
    q: "Where are the servers located?",
    a: `${regionNames}. More regions are coming soon.`,
  },
  {
    q: "Which operating systems and stacks can I choose?",
    a: `${osNames}, or a ready-made stack: ${stackNames}.`,
  },
  {
    q: "How do I get access to my server?",
    a: "Full root SSH access. Your IP and login details are in your dashboard and email within minutes of payment.",
  },
  {
    q: "Standard or Dedicated — what's the difference?",
    a: "Standard plans run on shared resources with an intro price for your first term, then renew monthly. Dedicated plans have guaranteed resources and one flat monthly price that never changes.",
  },
  {
    q: "Can I move to a bigger plan later?",
    a: "Yes. Open a support ticket and we'll help.",
  },
];

/** Spec-by-spec comparison of VPS plans for the selected cycle. */
function CompareTable({ plans, cycle }: { plans: PublicPlan[]; cycle: CycleKey }) {
  const rows: { label: string; value: (p: PublicPlan) => React.ReactNode; mono?: boolean }[] = [
    { label: "vCPU", value: (p) => p.vcpu ?? "—", mono: true },
    { label: "RAM", value: (p) => (p.ramGB ? `${p.ramGB} GB` : "—"), mono: true },
    { label: "NVMe SSD", value: (p) => (p.storageGB ? formatStorage(p.storageGB) : "—"), mono: true },
    { label: "Bandwidth", value: (p) => (p.bandwidthTB ? `${p.bandwidthTB} TB` : "—"), mono: true },
    {
      label: `Price (${CYCLES[cycle].label.toLowerCase()})`,
      value: (p) => {
        const c = availableCycles(p).includes(cycle) ? cycle : null;
        const rate = c ? firstTermRate(p, c, false) : null;
        return rate !== null ? `${formatINR(rate)}/mo` : "—";
      },
    },
    {
      label: "Renews at",
      value: (p) => {
        const r = renewalRate(p, cycle);
        return r !== null ? `${formatINR(r)}/mo` : "—";
      },
    },
  ];

  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-140 text-sm">
        <caption className="sr-only">VPS plan comparison</caption>
        <thead>
          <tr className="bg-surface">
            <th scope="col" className="text-left font-medium text-fg-muted px-5 py-3 w-1/4">
              Spec
            </th>
            {plans.map((p) => (
              <th key={p.id} scope="col" className="text-left px-5 py-3 font-semibold text-fg">
                {p.name}
                {p.isPopular && (
                  <span className="ml-2 text-xs font-medium text-link">Popular</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-line">
              <th scope="row" className="text-left font-normal text-fg-muted px-5 py-3">
                {row.label}
              </th>
              {plans.map((p) => (
                <td key={p.id} className={`px-5 py-3 text-fg tabular-nums ${row.mono ? "font-mono" : ""}`}>
                  {row.value(p)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t border-line">
            <td className="px-5 py-3" />
            {plans.map((p) => (
              <td key={p.id} className="px-5 py-3">
                <Link
                  href={`/order/${p.slug}?cycle=${availableCycles(p).includes(cycle) ? cycle : availableCycles(p).at(-1)}`}
                  className="text-link font-medium hover:underline"
                >
                  Deploy {p.name}
                  <span aria-hidden> →</span>
                </Link>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default function PricingClient({ plans, initialTab }: { plans: PublicPlan[]; initialTab: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [cycle, setCycle] = useState<CycleKey>("1year");

  const vpsPlans = plans.filter((p) => p.category === "VPS" && !p.isDedicated);
  const storagePlans = plans.filter((p) => p.category === "STORAGE" && !p.isDedicated);
  const dedicatedVps = plans.filter((p) => p.category === "VPS" && p.isDedicated);
  const dedicatedStorage = plans.filter((p) => p.category === "STORAGE" && p.isDedicated);
  const shown = tab === "VPS" ? vpsPlans : tab === "STORAGE" ? storagePlans : [];
  const shownCycle = tab === "VPS" ? cycle : STORAGE_CYCLE;
  const cheapestRenewal = Math.min(
    ...shown.map((p) => renewalRate(p, shownCycle)).filter((r): r is number => r !== null)
  );
  const showCompare = tab === "VPS" && vpsPlans.filter((p) => p.vcpu || p.ramGB).length >= 2;

  function chooseTab(next: Tab) {
    setTab(next);
    // Keep the URL shareable without a navigation.
    const query = TABS.find((t) => t.key === next)!.query;
    window.history.replaceState(null, "", next === "VPS" ? "/pricing" : `/pricing?tab=${query}`);
  }

  function crossLink(label: string) {
    return (
      <p className="text-center mt-6">
        <button
          type="button"
          onClick={() => chooseTab("DEDICATED")}
          className="text-sm font-medium text-link hover:underline cursor-pointer"
        >
          {label}
          <span aria-hidden> →</span>
        </button>
      </p>
    );
  }

  return (
    <div className="min-h-screen bg-canvas">
      <Navbar />

      {/* ── Header ── */}
      <section className="pt-14 pb-2 px-4 text-center">
        <p className="text-sm font-medium text-link mb-3">Pricing</p>
        <h1 className="text-3xl sm:text-4xl font-bold text-fg tracking-tight max-w-2xl mx-auto">{HEADLINES[tab].title}</h1>
        <p className="text-fg-muted text-base sm:text-lg max-w-2xl mx-auto mt-4">{HEADLINES[tab].sub}</p>
        <p className="text-xs text-fg-muted mt-4">
          Prices in INR · {PROCESSING_FEE_PERCENT}% charges at checkout
          {GST_PERCENT > 0 && ` · GST ${GST_PERCENT}% extra`}
        </p>
      </section>

      {/* ── Product tabs ── */}
      <div className="flex justify-center px-4 mt-8">
        <div className="inline-flex p-1 gap-1 rounded-xl bg-surface border border-line" role="tablist" aria-label="Product">
          {TABS.map((t) => {
            const isActive = tab === t.key;
            return (
              <button
                key={t.key}
                id={`tab-${t.query}`}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls="pricing-panel"
                onClick={() => chooseTab(t.key)}
                className={`h-10 px-4 sm:px-5 rounded-lg text-sm font-semibold whitespace-nowrap cursor-pointer transition-colors duration-150 ${
                  isActive ? "bg-surface-2 text-fg" : "text-fg-muted hover:text-fg"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div id="pricing-panel" role="tabpanel" aria-labelledby={`tab-${TABS.find((t) => t.key === tab)!.query}`}>
        {/* ── Billing cycle (VPS and Dedicated) ── */}
        <div className="flex flex-col items-center gap-2 px-4 mt-6 min-h-16">
          {tab === "VPS" ? (
            <CyclePicker plans={vpsPlans} cycle={cycle} onChange={setCycle} />
          ) : tab === "STORAGE" ? (
            <p className="text-sm text-fg-muted text-center">Prices for {CYCLES[STORAGE_CYCLE].label.toLowerCase()} billing</p>
          ) : (
            <CyclePicker plans={[...dedicatedVps, ...dedicatedStorage]} cycle={cycle} onChange={setCycle} />
          )}
        </div>

        {/* ── Plans ── */}
        {tab === "DEDICATED" ? (
          <section className="py-10" aria-label="Dedicated plans">
            <div
              className={`mx-auto px-4 sm:px-6 lg:px-8 flex flex-col gap-14 ${
                Math.max(dedicatedVps.length, dedicatedStorage.length) >= 4 ? "max-w-7xl" : "max-w-6xl"
              }`}
            >
              {[
                { id: "dedicated-vps", title: "Dedicated VPS", sub: "Guaranteed vCPU, RAM and NVMe — not shared with anyone.", list: dedicatedVps },
                { id: "dedicated-s4", title: "Dedicated S4 Storage", sub: "Your own bucket with guaranteed throughput and priority egress.", list: dedicatedStorage },
              ]
                .filter((section) => section.list.length > 0)
                .map((section) => (
                  <div key={section.id}>
                    <h2 id={section.id} className="text-xl font-semibold text-fg">
                      {section.title}
                    </h2>
                    <p className="text-sm text-fg-muted mt-1 mb-8">{section.sub}</p>
                    <DedicatedGrid plans={section.list} cycle={cycle} />
                  </div>
                ))}

              {dedicatedVps.length + dedicatedStorage.length === 0 && (
                <p className="text-center text-fg-muted py-20 rounded-xl border border-line bg-surface">
                  No dedicated plans available right now.
                </p>
              )}

              {/* Standard vs Dedicated */}
              <div className="rounded-xl border border-line bg-surface p-6">
                <h2 className="text-base font-semibold text-fg">Dedicated plans vs Standard</h2>
                <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <div className="rounded-lg bg-canvas p-4">
                    <dt className="font-medium text-fg">Standard</dt>
                    <dd className="text-fg-muted mt-1">Shared resources · intro price for your first term, then a monthly renewal price</dd>
                  </div>
                  <div className="rounded-lg bg-canvas p-4 border border-premium/30">
                    <dt className="font-medium text-premium">Dedicated</dt>
                    <dd className="text-fg-muted mt-1">Guaranteed resources · flat monthly price, or save with a 1 or 2 year term</dd>
                  </div>
                </dl>
              </div>

              {/* Custom requirements */}
              <div className="text-center">
                <p className="text-fg font-medium">Have custom requirements?</p>
                <p className="text-sm text-fg-muted mt-1">
                  {SALES_WHATSAPP ? (
                    <>
                      WhatsApp us at{" "}
                      <a
                        href={`https://wa.me/${SALES_WHATSAPP}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-link font-medium hover:underline"
                      >
                        {formatPhone(SALES_WHATSAPP)}
                      </a>{" "}
                      or email{" "}
                    </>
                  ) : (
                    "Email "
                  )}
                  <a href="mailto:sales@sowsicloud.com" className="text-link font-medium hover:underline">
                    sales@sowsicloud.com
                  </a>
                </p>
              </div>
            </div>
          </section>
        ) : (
        <section className="py-10" aria-label="Plans">
          <div className={`mx-auto px-4 sm:px-6 lg:px-8 ${shown.length >= 4 ? "max-w-7xl" : "max-w-6xl"}`}>
            {shown.length === 0 ? (
              <div className="text-center py-20 rounded-xl border border-line bg-surface">
                <p className="text-fg font-medium">No plans available right now</p>
                <p className="text-fg-muted text-sm mt-1">
                  Email{" "}
                  <a href="mailto:sales@sowsicloud.com" className="text-link hover:underline">
                    sales@sowsicloud.com
                  </a>{" "}
                  and we&apos;ll set you up.
                </p>
              </div>
            ) : (
              <>
                <PlanGrid plans={shown} cycle={shownCycle} />
                {Number.isFinite(cheapestRenewal) && (
                  <p className="text-center text-xs text-fg-muted mt-8">
                    Intro price for your first term, then renews from {formatINR(cheapestRenewal)}/mo. Cancel anytime.
                  </p>
                )}
                {tab === "VPS" && dedicatedVps.length > 0 && crossLink("Need more power? See Dedicated plans")}
                {tab === "STORAGE" && dedicatedStorage.length > 0 && crossLink("Need dedicated storage? See Dedicated plans")}
              </>
            )}
          </div>
        </section>
        )}

        {/* ── Compare ── */}
        {showCompare && (
          <section className="pb-16 px-4 sm:px-6 lg:px-8" aria-labelledby="compare-heading">
            <div className="max-w-5xl mx-auto">
              <h2 id="compare-heading" className="text-xl font-semibold text-fg mb-1">
                Compare plans
              </h2>
              <p className="text-sm text-fg-muted mb-5">Prices for {CYCLES[cycle].label.toLowerCase()} billing</p>
              <CompareTable plans={vpsPlans} cycle={cycle} />
            </div>
          </section>
        )}
      </div>

      {/* ── Included in all plans ── */}
      {tab === "VPS" && (
        <section className="py-16 px-4 border-t border-line" aria-labelledby="included-heading">
          <div className="max-w-5xl mx-auto">
            <h2 id="included-heading" className="text-xl font-semibold text-fg mb-6">
              Every VPS includes
            </h2>
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {INCLUDED.map((item) => (
                <li key={item.label} className="flex items-start gap-3 rounded-xl bg-surface border border-line p-4">
                  <svg className="w-5 h-5 text-link shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={item.icon} />
                  </svg>
                  <div>
                    <p className="text-sm font-medium text-fg">{item.label}</p>
                    <p className="text-xs text-fg-muted mt-0.5">{item.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* ── FAQ ── */}
      <section className="py-16 px-4 border-t border-line" aria-labelledby="faq-heading">
        <div className="max-w-3xl mx-auto">
          <h2 id="faq-heading" className="text-xl font-semibold text-fg mb-6">
            Questions about pricing
          </h2>
          <div className="flex flex-col divide-y divide-line border-y border-line">
            {FAQ.map((item) => (
              <details key={item.q} className="group">
                <summary className="flex items-center justify-between gap-4 py-4 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                  <span className="text-sm sm:text-base font-medium text-fg">{item.q}</span>
                  <svg
                    className="w-4 h-4 text-fg-muted shrink-0 transition-transform duration-200 group-open:rotate-180"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </summary>
                <p className="text-sm text-fg-muted pb-5 pr-8 leading-relaxed">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── Custom plan CTA ── */}
      <section className="pb-20 px-4">
        <div className="max-w-3xl mx-auto rounded-xl bg-surface border border-line p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5">
          <div>
            <h2 className="text-fg font-semibold text-lg">Need something bigger?</h2>
            <p className="text-fg-muted text-sm mt-1">Custom resources or dedicated hardware.</p>
          </div>
          <a
            href="mailto:sales@sowsicloud.com"
            className="shrink-0 inline-flex items-center h-10 px-4 rounded-lg text-sm font-semibold text-fg bg-surface border border-line-strong hover:border-fg-subtle hover:bg-surface-2 transition-colors duration-150"
          >
            Contact sales
          </a>
        </div>
      </section>
    </div>
  );
}
