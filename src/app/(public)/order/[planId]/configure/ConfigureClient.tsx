"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Navbar from "@/components/landing/Navbar";
import { REGIONS, DEFAULT_REGION, OS_IMAGES, DEFAULT_OS, getPresetsForCategory } from "@/lib/provisioning/catalog";
import { categoryLabel, isBillingCycle } from "@/lib/pricing";

type PlanData = {
  id: string;
  name: string;
  category: string;
  tier: string;
  price: number;
};

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

export default function ConfigureClient({ plan }: { plan: PlanData }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const cycleParam = Number(searchParams.get("cycle") || 12);
  const billingCycle = isBillingCycle(cycleParam) ? cycleParam : 12;
  const addonsParam = searchParams.get("addons");
  const initialAddons = useMemo(
    () => new Set((addonsParam ? addonsParam.split(",") : []).filter(Boolean)),
    [addonsParam]
  );

  const presets = getPresetsForCategory(plan.category);

  const [region] = useState(DEFAULT_REGION);
  const [stackPreset, setStackPreset] = useState(presets[0]?.value || "plain");
  const [osImage, setOsImage] = useState(DEFAULT_OS);
  const [hostname, setHostname] = useState("");
  const [enabledAddons, setEnabledAddons] = useState<Set<string>>(initialAddons);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activePreset = presets.find((p) => p.value === stackPreset) || presets[0];
  const lockedOs = activePreset?.lockedOs ?? null;

  function toggleAddon(id: string) {
    setEnabledAddons((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function validHostname(value: string) {
    return /^[a-zA-Z0-9-]{3,63}$/.test(value);
  }

  async function handleContinue() {
    setError(null);
    if (!validHostname(hostname)) {
      setError("Hostname must be 3-63 characters — letters, numbers, and hyphens only.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/orders/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId: plan.id,
          billingCycle,
          addons: Array.from(enabledAddons),
          region,
          osImage: lockedOs || osImage,
          stackPreset: activePreset?.value,
          hostname,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      router.push(`/order/${plan.id}/checkout?orderId=${data.data.orderId}`);
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div style={{ background: "linear-gradient(135deg, #0B1120 0%, #0F172A 50%, #0B1120 100%)", minHeight: "100vh" }}>
      <Navbar />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm mb-8 flex-wrap">
          <Link href="/pricing" className="text-gray-500 hover:text-gray-300 transition-colors">Pricing</Link>
          <span className="text-gray-600">→</span>
          <Link href={`/order/${plan.id}`} className="text-gray-500 hover:text-gray-300 transition-colors">{plan.name}</Link>
          <span className="text-gray-600">→</span>
          <span className="text-white font-medium">Configure</span>
        </div>

        <h1 className="text-2xl sm:text-3xl font-bold text-white mb-1">Configure your server</h1>
        <p className="text-gray-400 text-sm mb-8">
          {categoryLabel[plan.category] ?? plan.category} · {plan.name}
        </p>

        <div className="flex flex-col gap-8">
          {/* Region */}
          <div>
            <h3 className="text-white font-semibold text-lg mb-3">Region</h3>
            <select
              value={region}
              disabled
              className="w-full sm:w-auto px-4 py-3 rounded-xl text-sm text-white bg-white/5 border border-white/10 disabled:opacity-80"
            >
              {REGIONS.map((r) => (
                <option key={r.value} value={r.value} className="bg-[#111827]">{r.label}</option>
              ))}
            </select>
            <p className="text-gray-500 text-xs mt-2">More regions coming soon.</p>
          </div>

          {/* Stack preset */}
          {presets.length > 1 && (
            <div>
              <h3 className="text-white font-semibold text-lg mb-3">Server Type</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {presets.map((p) => {
                  const isSelected = stackPreset === p.value;
                  return (
                    <button
                      key={p.value}
                      onClick={() => setStackPreset(p.value)}
                      className="rounded-xl p-4 text-left transition-all duration-200"
                      style={{
                        background: isSelected ? "rgba(27,79,232,0.12)" : "rgba(255,255,255,0.03)",
                        border: isSelected ? "2px solid #1B4FE8" : "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      <p className={`text-sm font-semibold mb-1 ${isSelected ? "text-white" : "text-gray-300"}`}>{p.label}</p>
                      <p className="text-xs text-gray-500">{p.description}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* OS image */}
          <div>
            <h3 className="text-white font-semibold text-lg mb-3">Operating System</h3>
            {lockedOs ? (
              <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <p className="text-white text-sm font-medium">{OS_IMAGES.find((o) => o.value === lockedOs)?.label}</p>
                <p className="text-gray-500 text-xs mt-1">Locked to this OS for the {activePreset?.label} preset.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {OS_IMAGES.map((os) => {
                  const isSelected = osImage === os.value;
                  return (
                    <button
                      key={os.value}
                      onClick={() => setOsImage(os.value)}
                      className="rounded-xl p-4 text-left text-sm font-medium transition-all duration-200"
                      style={{
                        background: isSelected ? "rgba(27,79,232,0.12)" : "rgba(255,255,255,0.03)",
                        border: isSelected ? "2px solid #1B4FE8" : "1px solid rgba(255,255,255,0.08)",
                        color: isSelected ? "#fff" : "#D1D5DB",
                      }}
                    >
                      {os.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Hostname */}
          <div>
            <h3 className="text-white font-semibold text-lg mb-3">Hostname</h3>
            <input
              type="text"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="e.g. my-app-server"
              className="w-full px-4 py-3 rounded-xl text-sm text-white bg-white/5 border border-white/10 placeholder:text-gray-600 focus:outline-none focus:border-[#1B4FE8]"
            />
            <p className="text-gray-500 text-xs mt-2">Letters, numbers, and hyphens only. You can point a domain to this later.</p>
          </div>

          {/* Add-ons */}
          <div>
            <h3 className="text-white font-semibold text-lg mb-3">Add-ons</h3>
            <div className="flex flex-col gap-3">
              {ADDONS.map((addon) => {
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
                    <div className="w-11 h-6 rounded-full p-0.5 transition-colors shrink-0"
                      style={{ background: isOn ? "#1B4FE8" : "rgba(255,255,255,0.1)" }}>
                      <div className="w-5 h-5 rounded-full bg-white transition-transform"
                        style={{ transform: isOn ? "translateX(20px)" : "translateX(0)" }} />
                    </div>
                    <span className="text-2xl shrink-0">{addon.icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-semibold ${isOn ? "text-white" : "text-gray-300"}`}>{addon.name}</p>
                      <p className="text-xs text-gray-500">{addon.description}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-white">₹{addon.price.toLocaleString("en-IN")}</p>
                      <p className="text-xs text-gray-500">/month</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-400 rounded-lg px-4 py-3" style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.25)" }}>
              {error}
            </p>
          )}

          <button
            onClick={handleContinue}
            disabled={submitting || !hostname}
            className="w-full sm:w-auto self-end px-8 py-3.5 rounded-xl font-semibold text-white text-sm transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "linear-gradient(135deg, #1B4FE8, #0EA5E9)", boxShadow: "0 4px 20px rgba(27,79,232,0.35)" }}
          >
            {submitting ? "Saving..." : "Continue to Payment"}
          </button>
        </div>
      </div>
    </div>
  );
}
