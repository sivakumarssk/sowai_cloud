"use client";

import { useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { useRouter } from "next/navigation";
import Navbar from "@/components/landing/Navbar";
import { Button } from "@/components/ui/Button";
import { OrderSteps } from "@/components/order/OrderSteps";
import { OrderSummary, MobileOrderBar, PaymentNote } from "@/components/order/OrderSummary";
import { useAuthStore } from "@/store/authStore";
import { type PriceQuote, CYCLES, formatINR } from "@/lib/pricing";

type OrderData = {
  id: string;
  planName: string;
  category: string;
  hostname: string;
  region: string;
  os: string | null;
  stack: string | null;
};

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => { open: () => void };
  }
}

type PayError = { message: string; paymentId?: string };

export default function CheckoutClient({
  planSlug,
  order,
  quote,
  planHref,
  configureHref,
  razorpayKeyId,
}: {
  planSlug: string;
  order: OrderData;
  quote: PriceQuote;
  planHref: string;
  configureHref: string;
  razorpayKeyId: string;
}) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [scriptReady, setScriptReady] = useState(false);
  const [scriptFailed, setScriptFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PayError | null>(null);

  const isStorage = order.category === "STORAGE";
  const total = formatINR(quote.total);
  const unavailable = !razorpayKeyId
    ? "Online payments aren't available right now. Please contact support to complete your order."
    : scriptFailed
    ? "Couldn't load the Razorpay payment window. Check your connection or disable content blockers, then reload this page."
    : null;

  async function confirmPayment(response: {
    razorpay_subscription_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }) {
    try {
      const verifyRes = await fetch("/api/payment/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response),
      });
      const verifyData = await verifyRes.json();
      if (verifyRes.ok && verifyData.success) {
        const serviceId = verifyData.data?.serviceId;
        router.push(`/order/${planSlug}/provisioning?orderId=${order.id}${serviceId ? `&serviceId=${serviceId}` : ""}`);
        return;
      }
    } catch {
      // Fall through: the payment itself went through, only our confirmation failed.
    }
    // Razorpay's webhook will usually still activate the order, so never invite a second payment here.
    setError({
      message:
        "Your payment went through, but we couldn't confirm it yet. Please don't pay again — your server will appear in My Servers within a few minutes. If it doesn't, contact support with this payment ID.",
      paymentId: response.razorpay_payment_id,
    });
    setLoading(false);
  }

  async function handlePay() {
    setError(null);
    if (unavailable || !scriptReady) return;

    setLoading(true);
    try {
      const res = await fetch("/api/payment/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError({ message: data.error || "Couldn't start the payment. You haven't been charged — please try again." });
        setLoading(false);
        return;
      }

      // Autopay: the widget authorises a recurring mandate and charges the
      // first billing cycle; Razorpay then renews automatically.
      const rzp = new window.Razorpay({
        key: razorpayKeyId,
        subscription_id: data.data.razorpaySubscriptionId,
        name: "Sowsi Cloud Services",
        description: `${data.data.planName} — ${order.hostname}`,
        prefill: { name: user?.name, email: user?.email },
        theme: { color: "#2563EB" }, // --color-primary
        handler: confirmPayment,
        modal: {
          ondismiss: () => setLoading(false),
        },
      });
      rzp.open();
    } catch {
      setError({ message: "Couldn't reach Sowsi Cloud. You haven't been charged — check your connection and try again." });
      setLoading(false);
    }
  }

  const payLabel = !scriptReady && !unavailable ? "Loading secure payment…" : `Pay ${total}`;
  const payDisabled = !!unavailable || !scriptReady;

  const errorBox = error && (
    <div role="alert" className="text-sm text-danger rounded-lg bg-danger/10 border border-danger/30 px-3 py-2.5">
      <p>{error.message}</p>
      {error.paymentId && (
        <p className="mt-2 text-fg">
          Payment ID: <code className="font-mono select-all">{error.paymentId}</code>
        </p>
      )}
      {error.paymentId && (
        <Link href="/dashboard/services" className="inline-block mt-2 font-medium text-link hover:underline">
          Go to My Servers
        </Link>
      )}
    </div>
  );

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Plan", value: `${order.planName} · ${CYCLES[quote.cycle].label}` },
    { label: isStorage ? "Bucket name" : "Hostname", value: <code className="font-mono">{order.hostname}</code> },
    ...(order.os ? [{ label: "Operating system", value: order.os }] : []),
    ...(order.stack ? [{ label: "Pre-installed", value: order.stack }] : []),
    { label: "Location", value: order.region },
  ];

  return (
    <div className="min-h-screen bg-canvas pb-24 lg:pb-0">
      <Script
        src="https://checkout.razorpay.com/v1/checkout.js"
        onLoad={() => setScriptReady(true)}
        onError={() => setScriptFailed(true)}
      />
      <Navbar />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
        <OrderSteps current="Pay" hrefs={{ Plan: planHref, Configure: configureHref }} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 flex flex-col gap-6">
            <div>
              <h1 className="text-2xl font-semibold text-fg">Review and pay</h1>
              <p className="text-fg-muted text-sm mt-1">Setup starts as soon as you pay.</p>
            </div>

            <section aria-labelledby="review-heading" className="rounded-xl bg-surface border border-line">
              <div className="flex items-center justify-between px-5 py-4 border-b border-line">
                <h2 id="review-heading" className="text-fg font-semibold">
                  {isStorage ? "Storage" : "Server"}
                </h2>
                <Link href={configureHref} className="text-sm font-medium text-link hover:underline">
                  Edit
                </Link>
              </div>
              <dl className="divide-y divide-line">
                {rows.map((r) => (
                  <div key={r.label} className="flex justify-between gap-4 px-5 py-3 text-sm">
                    <dt className="text-fg-muted">{r.label}</dt>
                    <dd className="text-fg text-right min-w-0 break-all">{r.value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {unavailable && (
              <p role="alert" className="text-sm text-warning rounded-lg bg-warning/10 border border-warning/30 px-3 py-2.5">
                {unavailable}
              </p>
            )}
            <div className="lg:hidden">{errorBox}</div>
          </div>

          <aside className="lg:col-span-1" aria-label="Order summary">
            <div className="lg:sticky lg:top-24">
              <OrderSummary planName={order.planName} quote={quote}>
                {error && <div className="hidden lg:block mt-5">{errorBox}</div>}
                <Button size="lg" className="w-full mt-5" onClick={handlePay} loading={loading} disabled={payDisabled}>
                  {payLabel}
                </Button>
                <PaymentNote />
              </OrderSummary>
            </div>
          </aside>
        </div>
      </div>

      <MobileOrderBar total={quote.total}>
        <Button size="lg" onClick={handlePay} loading={loading} disabled={payDisabled}>
          {payLabel}
        </Button>
      </MobileOrderBar>
    </div>
  );
}
