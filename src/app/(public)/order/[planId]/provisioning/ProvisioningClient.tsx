"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Navbar from "@/components/landing/Navbar";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { OrderSteps } from "@/components/order/OrderSteps";

type ProvisioningStatus = {
  status: string;
  provisioningStep: string | null;
  provisioningPct: number;
  serverIp: string | null;
  ipv6Address: string | null;
};

const POLL_MS = 3000;
/** After this long without a service, the payment webhook is probably delayed. */
const SLOW_CONFIRM_MS = 2 * 60 * 1000;
/** Setup normally finishes well within this. */
const SLOW_SETUP_MS = 15 * 60 * 1000;
const DASHBOARD_URL = "/dashboard/services";

export default function ProvisioningClient({
  orderId,
  initialServiceId,
}: {
  orderId: string;
  initialServiceId: string | null;
}) {
  const [serviceId, setServiceId] = useState(initialServiceId);
  const [info, setInfo] = useState<ProvisioningStatus | null>(null);
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  const isActive = info?.status === "ACTIVE";
  const failed = info?.status === "FAILED";
  const finished = isActive || failed;

  // Poll every 3s. Chained timeouts (not setInterval) so a slow response can't
  // stack overlapping requests. Until the service exists (webhook/verify still
  // landing), look it up from the order.
  useEffect(() => {
    if (finished) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        if (!serviceId) {
          const res = await fetch(`/api/orders/${orderId}/status`, { cache: "no-store" });
          const data = await res.json();
          const id: string | undefined = data.data?.service?.id;
          if (!cancelled && id) {
            setServiceId(id); // re-runs this effect against the service endpoint
            return;
          }
        } else {
          const res = await fetch(`/api/services/${serviceId}/status`, { cache: "no-store" });
          const data = await res.json();
          if (!cancelled && res.ok && data.success) {
            const next: ProvisioningStatus = data.data;
            setInfo(next);
            if (next.status === "ACTIVE" || next.status === "FAILED") return;
          }
        }
      } catch {
        // Keep polling — transient network errors shouldn't stop the loop.
      }
      if (!cancelled) {
        setNow(Date.now());
        timer = setTimeout(poll, POLL_MS);
      }
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [orderId, serviceId, finished]);

  const elapsed = now - startedAt;
  const slowConfirm = !serviceId && elapsed > SLOW_CONFIRM_MS;
  const slowSetup = !!serviceId && !finished && elapsed > SLOW_SETUP_MS;
  const pct = isActive ? 100 : info?.provisioningPct ?? 0;
  const step = isActive
    ? "Server is ready"
    : info?.provisioningStep || (serviceId ? "Starting…" : "Confirming your payment…");

  return (
    <div className="min-h-screen bg-canvas">
      <Navbar />

      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
        <OrderSteps current="Deploy" />

        <div className="text-center mb-8">
          {isActive && (
            <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-success/10 text-success mb-4" aria-hidden>
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </span>
          )}
          <h1 className="text-2xl sm:text-3xl font-semibold text-fg mb-2">
            {failed ? "We couldn't finish setting up your server" : isActive ? "Your server is ready" : "Setting up your server"}
          </h1>
          <p className="text-fg-muted text-sm max-w-md mx-auto" aria-live="polite">
            {failed
              ? "Our team has been notified, and we've emailed you about your refund."
              : isActive
              ? "Your SSH login details are in your dashboard and have been emailed to you."
              : "This usually takes a few minutes. You can leave this page — we'll email you when it's ready."}
          </p>
        </div>

        {!failed && (
          <div className="rounded-xl bg-surface border border-line p-5 sm:p-6 mb-6">
            <div className="flex items-center justify-between gap-3 mb-3">
              <span className="flex items-center gap-2 text-sm font-medium text-fg min-w-0">
                {!isActive && <span className="w-2 h-2 rounded-full bg-link animate-pulse shrink-0" aria-hidden />}
                <span className="truncate">{step}</span>
              </span>
              <span className={`text-sm font-semibold tabular-nums ${isActive ? "text-success" : "text-link"}`}>{pct}%</span>
            </div>
            <div
              className="h-2 w-full rounded-full overflow-hidden bg-surface-2"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label="Server setup progress"
            >
              <div
                className={`h-full rounded-full transition-[width] duration-700 ease-out ${isActive ? "bg-success" : "bg-link"}`}
                style={{ width: `${pct}%` }}
              />
            </div>

            {slowConfirm && (
              <p className="text-sm text-fg-muted mt-4">
                Confirming your payment with Razorpay is taking longer than usual. You won&apos;t be charged again, and
                it&apos;s safe to leave — your server will appear in{" "}
                <Link href={DASHBOARD_URL} className="text-link hover:underline">
                  My Servers
                </Link>{" "}
                once it&apos;s confirmed.
              </p>
            )}
            {slowSetup && (
              <p className="text-sm text-fg-muted mt-4">
                This is taking longer than usual. We&apos;ll email you when it&apos;s ready, or you can{" "}
                <Link href="/dashboard/support" className="text-link hover:underline">
                  contact support
                </Link>
                .
              </p>
            )}
          </div>
        )}

        {isActive && (info?.serverIp || info?.ipv6Address) && (
          <dl className="rounded-xl bg-surface border border-line divide-y divide-line mb-6">
            <IpRow label="IPv4" value={info?.serverIp} />
            <IpRow label="IPv6" value={info?.ipv6Address} />
          </dl>
        )}

        {failed && (
          <p className="text-sm text-danger rounded-lg bg-danger/10 border border-danger/30 px-4 py-3 mb-6">
            {info?.provisioningStep || "Provisioning failed."}
          </p>
        )}

        <div className="flex flex-col sm:flex-row justify-center gap-3">
          <Link href={DASHBOARD_URL}>
            <Button size="lg" variant={isActive ? "primary" : "secondary"} className="w-full sm:w-auto">
              {isActive ? "Open my servers" : "Go to my servers"}
            </Button>
          </Link>
          {failed && (
            <Link href="/dashboard/support">
              <Button size="lg" className="w-full sm:w-auto">
                Contact support
              </Button>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function IpRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
      <dt className="text-fg-muted shrink-0">{label}</dt>
      <dd className="flex items-center gap-1 min-w-0">
        <code className="font-mono text-fg select-all break-all text-right">{value}</code>
        <CopyButton value={value} label={`${label} address`} />
      </dd>
    </div>
  );
}
