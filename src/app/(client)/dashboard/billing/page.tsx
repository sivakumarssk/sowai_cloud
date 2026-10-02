"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface Payment {
  id: string;
  invoiceNumber: string | null;
  amount: number;
  gstAmount: number;
  currency: string;
  status: string;
  createdAt: string;
  service: { plan: { name: string } } | null;
}

const statusColors: Record<string, string> = {
  SUCCESS: "bg-green-900/40 text-green-400 border-green-800",
  PENDING: "bg-amber-900/40 text-amber-400 border-amber-800",
  FAILED: "bg-red-900/40 text-red-400 border-red-800",
};

export default function BillingPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/payment/history")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setPayments(d.data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const totalSpent = payments
    .filter((p) => p.status === "SUCCESS")
    .reduce((sum, p) => sum + p.amount + p.gstAmount, 0);

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
        <p className="text-gray-500 text-sm mt-1">View all your payments and download GST invoices</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
          <p className="text-gray-500 text-xs mb-1">Total Paid</p>
          <p className="text-2xl font-bold text-white">₹{totalSpent.toLocaleString("en-IN")}</p>
        </div>
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
          <p className="text-gray-500 text-xs mb-1">Total Invoices</p>
          <p className="text-2xl font-bold text-white">{payments.filter((p) => p.status === "SUCCESS").length}</p>
        </div>
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
          <p className="text-gray-500 text-xs mb-1">Pending</p>
          <p className="text-2xl font-bold text-amber-400">{payments.filter((p) => p.status === "PENDING").length}</p>
        </div>
      </div>

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
                  <tr key={payment.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-6 py-4 text-white text-sm font-mono">
                      #{payment.invoiceNumber || "—"}
                    </td>
                    <td className="px-6 py-4 text-gray-300 text-sm">
                      {payment.service?.plan?.name || "—"}
                    </td>
                    <td className="px-6 py-4 text-gray-400 text-sm">
                      {new Date(payment.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                    </td>
                    <td className="px-6 py-4 text-white text-sm font-semibold text-right">
                      ₹{(payment.amount + payment.gstAmount).toLocaleString("en-IN")}
                    </td>
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
