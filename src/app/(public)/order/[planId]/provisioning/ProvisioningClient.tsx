"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Navbar from "@/components/landing/Navbar";

type ServiceInfo = {
  id: string;
  status: string;
  serverIp: string | null;
  hostname: string | null;
  panelUrl: string | null;
  provisionError: string | null;
} | null;

const STAGES = [
  { key: "PENDING", label: "Payment confirmed" },
  { key: "PROVISIONING", label: "Setting up your server" },
  { key: "ACTIVE", label: "Server is ready" },
];

export default function ProvisioningClient({ orderId }: { orderId: string }) {
  const [service, setService] = useState<ServiceInfo>(null);
  const [orderStatus, setOrderStatus] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch(`/api/orders/${orderId}/status`);
        const data = await res.json();
        if (res.ok && data.success) {
          setOrderStatus(data.data.orderStatus);
          setService(data.data.service);
          if (data.data.service?.status === "ACTIVE" || data.data.service?.status === "FAILED") {
            if (pollRef.current) clearInterval(pollRef.current);
          }
        }
      } catch {
        // Keep polling — transient network errors shouldn't stop the loop.
      }
    }

    poll();
    pollRef.current = setInterval(poll, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [orderId]);

  const currentStageIndex = !service
    ? 0
    : service.status === "ACTIVE"
    ? 2
    : service.status === "PROVISIONING"
    ? 1
    : 0;

  const failed = service?.status === "FAILED";

  return (
    <div style={{ background: "linear-gradient(135deg, #0B1120 0%, #0F172A 50%, #0B1120 100%)", minHeight: "100vh" }}>
      <Navbar />

      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-20">
        <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2 text-center">
          {failed ? "Something went wrong" : service?.status === "ACTIVE" ? "Your server is ready!" : "Setting up your server"}
        </h1>
        <p className="text-gray-400 text-sm mb-10 text-center">
          {failed
            ? "Our team has been notified and will resolve this shortly."
            : "This usually takes under a minute. You can leave this page — we'll email you when it's done."}
        </p>

        {!failed && (
          <div className="flex flex-col gap-4 mb-10">
            {STAGES.map((stage, i) => {
              const isDone = i < currentStageIndex || service?.status === "ACTIVE";
              const isCurrent = i === currentStageIndex && service?.status !== "ACTIVE";
              return (
                <div key={stage.key} className="flex items-center gap-4 rounded-xl p-4"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                    style={{
                      background: isDone ? "#059669" : isCurrent ? "#1B4FE8" : "rgba(255,255,255,0.06)",
                    }}>
                    {isDone ? (
                      <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    ) : isCurrent ? (
                      <div className="w-3 h-3 rounded-full bg-white animate-pulse" />
                    ) : (
                      <div className="w-2 h-2 rounded-full bg-gray-600" />
                    )}
                  </div>
                  <span className={`text-sm font-medium ${isDone || isCurrent ? "text-white" : "text-gray-500"}`}>
                    {stage.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {service?.status === "ACTIVE" && (
          <div className="rounded-2xl p-6 mb-8" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}>
            <div className="flex justify-between text-sm mb-3">
              <span className="text-gray-400">Hostname</span>
              <span className="text-white font-mono">{service.hostname}</span>
            </div>
            <div className="flex justify-between text-sm mb-3">
              <span className="text-gray-400">Server IP</span>
              <span className="text-white font-mono">{service.serverIp}</span>
            </div>
            <p className="text-gray-500 text-xs mt-4">
              Full login credentials have been sent to your email.
            </p>
          </div>
        )}

        {failed && (
          <p className="text-sm text-red-400 rounded-lg px-4 py-3 mb-8" style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.25)" }}>
            {service?.provisionError || "Provisioning failed. Please contact support."}
          </p>
        )}

        <div className="flex justify-center">
          <Link href="/dashboard/services"
            className="px-6 py-3 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90"
            style={{ background: "linear-gradient(135deg, #1B4FE8, #0EA5E9)" }}>
            Go to Dashboard
          </Link>
        </div>

        {orderStatus === "PAID" && !service && (
          <p className="text-gray-500 text-xs text-center mt-6">Waiting for server setup to begin...</p>
        )}
      </div>
    </div>
  );
}
