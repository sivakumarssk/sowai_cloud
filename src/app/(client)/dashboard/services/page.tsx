"use client";

import { useState, useEffect, useTransition } from "react";
import { showToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import Link from "next/link";

interface Service {
  id: string;
  status: "PENDING" | "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "FAILED";
  serverIp: string | null;
  sshUsername: string | null;
  sshPassword: string | null;
  panelUrl: string | null;
  hostname: string | null;
  nextBillingDate: string;
  startDate: string;
  plan: {
    name: string;
    category: string;
    price: number;
    features: Record<string, string>;
  };
}

const statusColors: Record<Service["status"], string> = {
  PENDING: "bg-blue-900/40 text-blue-400 border-blue-800",
  PROVISIONING: "bg-blue-900/40 text-blue-400 border-blue-800",
  ACTIVE: "bg-green-900/40 text-green-400 border-green-800",
  SUSPENDED: "bg-amber-900/40 text-amber-400 border-amber-800",
  CANCELLED: "bg-red-900/40 text-red-400 border-red-800",
  FAILED: "bg-red-900/40 text-red-400 border-red-800",
};

const statusLabels: Record<Service["status"], string> = {
  PENDING: "Setting up",
  PROVISIONING: "Provisioning",
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  CANCELLED: "CANCELLED",
  FAILED: "Setup failed",
};

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={copy}
      className="text-xs text-[#1B4FE8] hover:text-[#0EA5E9] transition-colors ml-2 font-medium"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

export default function ServicesPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/services")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setServices(d.data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="animate-spin w-8 h-8 border-2 border-[#1B4FE8] border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">My Services</h1>
          <p className="text-gray-500 text-sm mt-1">
            Manage all your hosting services
          </p>
        </div>
        <Link href="/pricing">
          <Button>Add Service</Button>
        </Link>
      </div>

      {services.length === 0 ? (
        <div className="bg-[#111827] border border-[#1F2937] rounded-2xl p-16 text-center">
          <div className="w-16 h-16 bg-[#1B4FE8]/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-[#60A5FA]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
            </svg>
          </div>
          <h2 className="text-white font-semibold text-lg mb-2">No services yet</h2>
          <p className="text-gray-500 text-sm mb-6">
            Get started by choosing a hosting plan that fits your needs.
          </p>
          <Link href="/pricing">
            <Button>Browse Plans</Button>
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {services.map((service) => (
            <div
              key={service.id}
              className="bg-[#111827] border border-[#1F2937] rounded-xl p-6"
            >
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-5">
                <div>
                  <div className="flex items-center gap-3 mb-1">
                    <h3 className="text-white font-semibold text-lg">{service.plan.name}</h3>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-md border ${statusColors[service.status]}`}>
                      {statusLabels[service.status]}
                    </span>
                  </div>
                  <p className="text-gray-500 text-sm">
                    {service.plan.category.replace("_", " ")} • ₹{service.plan.price.toLocaleString("en-IN")}/month
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  {service.panelUrl && (
                    <a href={service.panelUrl} target="_blank" rel="noopener noreferrer">
                      <Button variant="secondary" size="sm">
                        Open Panel
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </Button>
                    </a>
                  )}
                  <Link href="/pricing">
                    <Button variant="secondary" size="sm">Upgrade</Button>
                  </Link>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {service.serverIp && (
                  <div className="bg-[#0A0F1E] rounded-lg p-3">
                    <p className="text-gray-500 text-xs mb-1">Server IP</p>
                    <div className="flex items-center">
                      <code className="text-white text-sm font-mono">{service.serverIp}</code>
                      <CopyButton value={service.serverIp} />
                    </div>
                  </div>
                )}
                {service.sshUsername && (
                  <div className="bg-[#0A0F1E] rounded-lg p-3">
                    <p className="text-gray-500 text-xs mb-1">SSH Username</p>
                    <div className="flex items-center">
                      <code className="text-white text-sm font-mono">{service.sshUsername}</code>
                      <CopyButton value={service.sshUsername} />
                    </div>
                  </div>
                )}
                {service.sshPassword && (
                  <div className="bg-[#0A0F1E] rounded-lg p-3">
                    <p className="text-gray-500 text-xs mb-1">SSH Password</p>
                    <div className="flex items-center">
                      <code className="text-white text-sm font-mono">{"•".repeat(12)}</code>
                      <CopyButton value={service.sshPassword} />
                    </div>
                  </div>
                )}
                <div className="bg-[#0A0F1E] rounded-lg p-3">
                  <p className="text-gray-500 text-xs mb-1">Start Date</p>
                  <p className="text-white text-sm">
                    {new Date(service.startDate).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
                  </p>
                </div>
                <div className="bg-[#0A0F1E] rounded-lg p-3">
                  <p className="text-gray-500 text-xs mb-1">Next Billing</p>
                  <p className="text-white text-sm">
                    {new Date(service.nextBillingDate).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
