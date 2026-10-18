"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { CYCLES, cycleKeyFromMonths, formatINR, gstOn, processingFeeOn } from "@/lib/pricing";

interface Payment {
  id: string;
  invoiceNumber: string | null;
  amount: number;
  gstAmount: number;
  processingFee: number;
  currency: string;
  status: string;
  createdAt: string;
  service: { plan: { name: string } } | null;
}

interface BillingService {
  id: string;
  status: string;
  hostname: string | null;
  nextBillingDate: string;
  plan: { name: string };
  order: {
    billingCycle: number;
    amount: number;
    gstAmount: number;
    processingFee: number;
    isIntroPrice: boolean;
    renewalAmount: number | null;
    addons: string[];
  } | null;
  subscriptions: { status: string; billingCycle: number; amount: number; gstAmount: number; processingFee: number }[];
}

const statusColors: Record<string, string> = {
  SUCCESS: "bg-green-900/40 text-green-400 border-green-800",
  PENDING: "bg-amber-900/40 text-amber-400 border-amber-800",
  FAILED: "bg-red-900/40 text-red-400 border-red-800",
  REFUNDED: "bg-gray-800/60 text-gray-300 border-gray-700",
};

const RENEWAL_WARNING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const formatDate = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const AUTOPAY_ON = ["ACTIVE", "AUTHENTICATED", "PENDING"];

/**
 * What the next autopay charge will be: renewal price (excl. charges), the charges on
 * top, and months between charges. A live subscription's own charges are used, so
 * customers on an older rate see what they're actually billed.
 */
function renewalTerms(service: BillingService): { amount: number; charges: number; months: number } | null {
  const sub = service.subscriptions[0];
  if (sub) return { amount: sub.amount, charges: sub.processingFee + sub.gstAmount, months: sub.billingCycle };
  if (!service.order) return null;
  const amount = service.order.renewalAmount ?? service.order.amount;
  return {
    amount,
    charges: processingFeeOn(amount) + gstOn(amount),
    months: service.order.renewalAmount !== null ? 1 : service.order.billingCycle,
  };
}

function perText(months: number) {
  return months === 1 ? "/mo" : ` every ${CYCLES[cycleKeyFromMonths(months)].label.toLowerCase()}`;
}

export default function BillingPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [services, setServices] = useState<BillingService[]>([]);
  const [loading, setLoading] = useState(true);
  // Captured once so render stays pure (React Compiler).
  const [now] = useState(() => Date.now());

  useEffect(() => {
    Promise.all([
      fetch("/api/payment/history").then((r) => r.json()),
      fetch("/api/services").then((r) => r.json()),
    ])
      .then(([p, s]) => {
        if (p.success) setPayments(p.data);
        if (s.success) setServices(s.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const total = (p: Payment) => p.amount + p.gstAmount + p.processingFee;
  const totalSpent = payments.filter((p) => p.status === "SUCCESS").reduce((sum, p) => sum + total(p), 0);
  const billable = services.filter((s) => s.status === "ACTIVE" || s.status === "SUSPENDED");
  const renewingSoon = billable.filter((s) => {
    const days = (new Date(s.nextBillingDate).getTime() - now) / DAY_MS;
    return s.status === "ACTIVE" && days >= 0 && days <= RENEWAL_WARNING_DAYS;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="animate-spin w-8 h-8 border-2 border-[#1B4FE8] border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Billing & Invoices</h1>
        <p className="text-gray-500 text-sm mt-1">Your plans, renewals and payment history</p>
      </div>

      {/* Renewal banners */}
      {renewingSoon.map((s) => {
        const terms = renewalTerms(s);
        const autopayOn = AUTOPAY_ON.includes(s.subscriptions[0]?.status ?? "");
        return (
          <div
            key={s.id}
            className="mb-4 rounded-xl border border-amber-800/60 bg-amber-900/20 px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
          >
            <p className="text-sm text-amber-200">
              {terms ? (
                <>
                  Your <strong>{s.plan.name}</strong> renews at{" "}
                  <strong>
                    {formatINR(terms.amount)}
                    {perText(terms.months)}
                  </strong>{" "}
                  on {formatDate(s.nextBillingDate)}.
                </>
              ) : (
                <>
                  Your <strong>{s.plan.name}</strong> is paid until {formatDate(s.nextBillingDate)}.
                </>
              )}{" "}
              {autopayOn ? "Autopay will charge it automatically." : "Autopay is off — restart it to keep your server running."}
            </p>
            <div className="flex gap-2 shrink-0">
              {!autopayOn && (
                <Link href="/dashboard/services" className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[#1B4FE8] hover:opacity-90">
                  Restart autopay
                </Link>
              )}
              <Link
                href="/pricing"
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white border border-white/15 hover:bg-white/5"
              >
                Upgrade Plan
              </Link>
            </div>
          </div>
        );
      })}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
          <p className="text-gray-500 text-xs mb-1">Total Paid</p>
          <p className="text-2xl font-bold text-white">{formatINR(totalSpent)}</p>
        </div>
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
          <p className="text-gray-500 text-xs mb-1">Total Invoices</p>
          <p className="text-2xl font-bold text-white">{payments.filter((p) => p.status === "SUCCESS").length}</p>
        </div>
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
          <p className="text-gray-500 text-xs mb-1">Active Plans</p>
          <p className="text-2xl font-bold text-white">{billable.length}</p>
        </div>
      </div>

      {/* Plans & renewals */}
      {billable.length > 0 && (
        <div className="mb-8">
          <h2 className="text-white font-semibold mb-3">Your Plans</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {billable.map((s) => {
              const o = s.order;
              const terms = renewalTerms(s);
              const autopay = s.subscriptions[0]?.status;
              return (
                <div key={s.id} className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
                  <div className="flex items-start justify-between gap-3 mb-4">
                    <div>
                      <p className="text-white font-semibold">{s.plan.name}</p>
                      {s.hostname && <p className="text-gray-500 text-xs mt-0.5">{s.hostname}</p>}
                    </div>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-md border ${
                        AUTOPAY_ON.includes(autopay ?? "")
                          ? "bg-green-900/40 text-green-400 border-green-800"
                          : "bg-amber-900/40 text-amber-400 border-amber-800"
                      }`}
                    >
                      {AUTOPAY_ON.includes(autopay ?? "") ? "Autopay on" : "Autopay off"}
                    </span>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                    <div>
                      <dt className="text-gray-500 text-xs">Billing cycle</dt>
                      <dd className="text-white">
                        {o ? CYCLES[cycleKeyFromMonths(o.billingCycle)].label : "—"}
                        {o?.isIntroPrice && <span className="text-emerald-400 text-xs"> · intro price</span>}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-gray-500 text-xs">Amount paid</dt>
                      <dd className="text-white">{o ? formatINR(o.amount + o.gstAmount + o.processingFee) : "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-gray-500 text-xs">{s.status === "SUSPENDED" ? "Was paid until" : "Next billing"}</dt>
                      <dd className="text-white">{formatDate(s.nextBillingDate)}</dd>
                    </div>
                    <div>
                      <dt className="text-gray-500 text-xs">Renewal price</dt>
                      <dd className="text-white">
                        {terms ? (
                          <>
                            {formatINR(terms.amount)}
                            {perText(terms.months)}
                            <span className="block text-gray-500 text-xs">
                              + {formatINR(terms.charges)} charges
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
                      </dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap gap-2 mt-5">
                    <Link
                      href="/dashboard/support"
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white border border-white/15 hover:bg-white/5"
                    >
                      Manage Add-ons
                    </Link>
                    <Link
                      href="/dashboard/services"
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-300 border border-white/10 hover:bg-white/5"
                    >
                      Manage autopay
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Invoices table */}
      <div className="bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-[#1F2937]">
          <h2 className="text-white font-semibold">Payment History</h2>
        </div>

        {payments.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-gray-500 text-sm">No payments yet</p>
            <Link href="/pricing" className="text-[#1B4FE8] text-sm mt-2 inline-block hover:underline">
              Get a hosting plan →
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#1F2937]">
                  <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Invoice</th>
                  <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Plan</th>
                  <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Date</th>
                  <th className="text-right px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Amount</th>
                  <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Status</th>
                  <th className="text-right px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1F2937]">
                {payments.map((payment) => (
                  <tr key={payment.id} className="hover:bg-white/2 transition-colors">
                    <td className="px-6 py-4 text-white text-sm font-mono">#{payment.invoiceNumber || "—"}</td>
                    <td className="px-6 py-4 text-gray-300 text-sm">{payment.service?.plan?.name || "—"}</td>
                    <td className="px-6 py-4 text-gray-400 text-sm">{formatDate(payment.createdAt)}</td>
                    <td className="px-6 py-4 text-white text-sm font-semibold text-right">{formatINR(total(payment))}</td>
                    <td className="px-6 py-4">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-md border ${statusColors[payment.status] || ""}`}>
                        {payment.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      {payment.status === "SUCCESS" && (
                        <a
                          href={`/api/payment/invoice/${payment.id}`}
                          className="text-[#1B4FE8] text-xs hover:text-[#0EA5E9] transition-colors font-medium"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Download
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
