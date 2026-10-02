"use client";

import { useState } from "react";
import Script from "next/script";
import { useRouter } from "next/navigation";
import Navbar from "@/components/landing/Navbar";
import { useAuthStore } from "@/store/authStore";
import { getRegion } from "@/lib/provisioning/catalog";

type OrderData = {
  id: string;
  planName: string;
  billingCycle: number;
  hostname: string;
  region: string;
  amount: number;
  gstAmount: number;
};

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => { open: () => void };
  }
}

export default function CheckoutClient({
  planId,
  order,
  razorpayKeyId,
}: {
  planId: string;
  order: OrderData;
  razorpayKeyId: string;
}) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [scriptReady, setScriptReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = order.amount + order.gstAmount;
  const regionLabel = getRegion(order.region)?.label || order.region;

  async function handlePay() {
    setError(null);

    if (!razorpayKeyId) {
      setError("Payments are not configured yet. Please contact support.");
      return;
    }
    if (!scriptReady || typeof window.Razorpay === "undefined") {
      setError("Payment widget is still loading. Please try again in a moment.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/payment/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || "Could not start payment. Please try again.");
        setLoading(false);
        return;
      }

      const rzp = new window.Razorpay({
        key: razorpayKeyId,
        amount: data.data.amount,
        currency: data.data.currency,
        name: "Sowsi Cloud Services",
        description: `${data.data.planName} — ${order.hostname}`,
        order_id: data.data.razorpayOrderId,
        prefill: { name: user?.name, email: user?.email },
        theme: { color: "#1B4FE8" },
        handler: async function (response: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) {
          const verifyRes = await fetch("/api/payment/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(response),
          });
          const verifyData = await verifyRes.json();
          if (verifyRes.ok && verifyData.success) {
            router.push(`/order/${planId}/provisioning?orderId=${order.id}`);
          } else {
            setError("Payment succeeded but confirmation failed. Please contact support with your payment ID.");
            setLoading(false);
          }
        },
        modal: {
          ondismiss: function () {
            setLoading(false);
          },
        },
      });
      rzp.open();
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div style={{ background: "linear-gradient(135deg, #0B1120 0%, #0F172A 50%, #0B1120 100%)", minHeight: "100vh" }}>
      <Script src="https://checkout.razorpay.com/v1/checkout.js" onLoad={() => setScriptReady(true)} />
      <Navbar />

      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
        <h1 className="text-2xl sm:text-3xl font-bold text-white mb-1">Payment</h1>
        <p className="text-gray-400 text-sm mb-8">Review your order and complete payment to activate your server.</p>

        <div className="rounded-2xl p-6 mb-6" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}>
          <div className="flex justify-between text-sm mb-3">
            <span className="text-gray-400">Plan</span>
            <span className="text-white font-medium">{order.planName}</span>
          </div>
          <div className="flex justify-between text-sm mb-3">
            <span className="text-gray-400">Hostname</span>
            <span className="text-white font-medium">{order.hostname}</span>
          </div>
          <div className="flex justify-between text-sm mb-3">
            <span className="text-gray-400">Region</span>
            <span className="text-white font-medium">{regionLabel}</span>
          </div>
          <div className="flex justify-between text-sm mb-3">
            <span className="text-gray-400">Billing Cycle</span>
            <span className="text-white font-medium">
              {order.billingCycle === 1 ? "Monthly" : order.billingCycle === 12 ? "1 Year" : "2 Years"}
            </span>
          </div>

          <div className="mt-4 pt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.1)" }}>
            <div className="flex justify-between text-sm mb-2">
              <span className="text-gray-400">Subtotal</span>
              <span className="text-white font-medium">₹{order.amount.toLocaleString("en-IN")}</span>
            </div>
            <div className="flex justify-between text-sm mb-3">
              <span className="text-gray-400">GST (18%)</span>
              <span className="text-white font-medium">₹{order.gstAmount.toLocaleString("en-IN")}</span>
            </div>
            <div className="flex justify-between pt-3" style={{ borderTop: "1px solid rgba(255,255,255,0.1)" }}>
              <span className="text-white font-bold text-lg">Total</span>
              <span className="text-white font-black text-xl">₹{total.toLocaleString("en-IN")}</span>
            </div>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-400 rounded-lg px-4 py-3 mb-6" style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.25)" }}>
            {error}
          </p>
        )}

        <button
          onClick={handlePay}
          disabled={loading}
          className="w-full py-3.5 rounded-xl font-semibold text-white text-sm transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
          style={{ background: "linear-gradient(135deg, #1B4FE8, #0EA5E9)", boxShadow: "0 4px 20px rgba(27,79,232,0.35)" }}
        >
          {loading ? "Opening payment..." : `Pay ₹${total.toLocaleString("en-IN")}`}
        </button>

        <div className="flex items-center justify-center gap-4 mt-4">
          {[
            { icon: "🔒", label: "Secured by Razorpay" },
            { icon: "🧾", label: "GST Invoice" },
          ].map((b) => (
            <div key={b.label} className="flex items-center gap-1 text-gray-600 text-[10px]">
              <span>{b.icon}</span>{b.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
