"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { showToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { StatusBadge, type ServiceStatus } from "@/components/ui/StatusBadge";
import { DELETE_AFTER_SUSPENDED_DAYS, BILLING_SUSPEND_REASON } from "@/lib/billing/constants";
import { formatINR, formatStorage, categoryLabel } from "@/lib/pricing";
import { getOsImage, getPreset, getRegion } from "@/lib/provisioning/catalog";

type AutopayStatus =
  | "CREATED" | "AUTHENTICATED" | "ACTIVE" | "PENDING" | "HALTED" | "PAUSED" | "CANCELLED" | "COMPLETED" | "EXPIRED";

interface Autopay {
  status: AutopayStatus;
  billingCycle: number;
  amount: number;
  gstAmount: number;
  processingFee: number;
  chargeAt: string | null;
  currentEnd: string | null;
}

interface Service {
  id: string;
  orderId: string | null;
  status: ServiceStatus;
  hostname: string | null;
  region: string;
  osImage: string | null;
  stackPreset: string | null;
  serverIp: string | null;
  ipv6Address: string | null;
  sshUsername: string | null;
  sshPassword: string | null;
  panelUrl: string | null;
  /** A real server (container, node, Floating IP, SSH check): only then are IP and credentials sent. */
  ready: boolean;
  provisioningStep: string | null;
  provisioningPct: number;
  nextBillingDate: string;
  startDate: string;
  suspendedAt: string | null;
  suspendReason: string | null;
  subscriptions: Autopay[];
  plan: {
    name: string;
    slug: string | null;
    category: string;
    vcpu: number | null;
    ramGB: number | null;
    storageGB: number | null;
  };
}

type Filter = "all" | "running" | "setup" | "attention";

const SETTING_UP: ServiceStatus[] = ["PENDING", "PROVISIONING", "INSTALLING"];
const REFRESH_MS = 5000;

const FILTERS: { key: Filter; label: string; match: (s: Service) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "running", label: "Running", match: (s) => s.status === "ACTIVE" },
  { key: "setup", label: "Setting up", match: (s) => SETTING_UP.includes(s.status) },
  { key: "attention", label: "Needs attention", match: (s) => needsAttention(s) },
];

const formatDate = (d: string | Date) =>
  new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const cycleText = (months: number) =>
  months === 1 ? "every month" : months === 12 ? "every year" : `every ${months / 12} years`;

function isAutopayLive(s: Service) {
  const status = s.subscriptions[0]?.status;
  return status === "ACTIVE" || status === "AUTHENTICATED";
}

/** Suspended, failed, a failed renewal, or autopay off on a running server. */
function needsAttention(s: Service) {
  if (s.status === "SUSPENDED" || s.status === "FAILED") return true;
  return s.status === "ACTIVE" && !isAutopayLive(s);
}

function specLine(plan: Service["plan"]) {
  const parts = [
    plan.vcpu && `${plan.vcpu} vCPU`,
    plan.ramGB && `${plan.ramGB} GB RAM`,
    plan.storageGB && (plan.category === "STORAGE" ? formatStorage(plan.storageGB) : `${plan.storageGB} GB NVMe`),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : categoryLabel[plan.category] ?? plan.category;
}

/** Autopay status and the matching action (cancel / restart / pay now) for one server. */
function AutopayPanel({ service, onChanged }: { service: Service; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  if (service.status !== "ACTIVE" && service.status !== "SUSPENDED") return null;

  const autopay = service.subscriptions[0];
  const isLive = isAutopayLive(service);
  const suspendedForBilling = service.status === "SUSPENDED" && service.suspendReason === BILLING_SUSPEND_REASON;
  const deleteOn =
    suspendedForBilling && service.suspendedAt
      ? new Date(new Date(service.suspendedAt).getTime() + DELETE_AFTER_SUSPENDED_DAYS * 24 * 60 * 60 * 1000)
      : null;

  async function restart() {
    setBusy(true);
    try {
      const res = await fetch(`/api/services/${service.id}/autopay/restart`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Couldn't start autopay");
      showToast(data.data.chargesNow ? "Redirecting to Razorpay to pay…" : "Redirecting to Razorpay to authorise autopay…");
      window.location.assign(data.data.shortUrl);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't start autopay", "error");
      setBusy(false);
    }
  }

  async function cancel() {
    const ok = window.confirm(
      `Cancel autopay? Your server keeps running until ${formatDate(service.nextBillingDate)}, then it is suspended ` +
        `and deleted ${DELETE_AFTER_SUSPENDED_DAYS} days later unless you restart autopay.`
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/services/${service.id}/autopay/cancel`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Couldn't cancel autopay");
      showToast("Autopay cancelled", "success");
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't cancel autopay", "error");
    } finally {
      setBusy(false);
    }
  }

  let tone: "ok" | "warn" | "danger";
  let message: string;
  let action: { label: string; onClick: () => void; variant: "primary" | "secondary" | "ghost" | "danger" } | null;

  if (suspendedForBilling) {
    tone = "danger";
    message = `Suspended for non-payment.${deleteOn ? ` It will be permanently deleted on ${formatDate(deleteOn)} unless you pay.` : ""}`;
    action = { label: "Pay now & restart autopay", onClick: restart, variant: "primary" };
  } else if (service.status === "SUSPENDED") {
    tone = "danger";
    message = "This server is suspended. Please contact support.";
    action = null;
  } else if (isLive) {
    tone = "ok";
    const total = autopay.amount + autopay.gstAmount + autopay.processingFee;
    const next = autopay.chargeAt ?? service.nextBillingDate;
    message = `Autopay on: ${formatINR(total)} ${cycleText(autopay.billingCycle)}. Next charge on ${formatDate(next)}.`;
    action = { label: "Cancel autopay", onClick: cancel, variant: "ghost" };
  } else if (autopay?.status === "PENDING") {
    tone = "warn";
    message = "Your last renewal payment failed. Razorpay is retrying automatically — you can switch to a different payment method.";
    action = { label: "Use another payment method", onClick: restart, variant: "secondary" };
  } else {
    tone = "warn";
    message = `Autopay is off. Paid until ${formatDate(service.nextBillingDate)}, then the server will be suspended.`;
    action = { label: "Restart autopay", onClick: restart, variant: "primary" };
  }

  const toneClass = {
    ok: "bg-surface border-line text-fg-muted",
    warn: "bg-warning/10 border-warning/30 text-warning",
    danger: "bg-danger/10 border-danger/30 text-danger",
  }[tone];

  return (
    <div className={`rounded-lg border px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${toneClass}`}>
      <p className="text-sm">{message}</p>
      {action && (
        <Button variant={action.variant} size="sm" onClick={action.onClick} loading={busy} className="shrink-0">
          {action.label}
        </Button>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-canvas rounded-lg px-3 py-2.5 min-w-0">
      <p className="text-xs font-medium text-fg-muted mb-0.5">{label}</p>
      <div className="flex items-center gap-1 min-h-8">{children}</div>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-sm text-fg truncate select-all">{children}</code>;
}

/** Credentials, IPs and billing for one server, shown when its row is expanded. */
function ServerDetails({ service, onChanged }: { service: Service; onChanged: () => void }) {
  const [showPassword, setShowPassword] = useState(false);
  const os = service.osImage ? getOsImage(service.osImage)?.label.replace(" (Recommended)", "") : null;
  const preset = service.stackPreset && service.stackPreset !== "plain" ? getPreset(service.stackPreset)?.label : null;
  const sshCommand = service.serverIp && service.sshUsername ? `ssh ${service.sshUsername}@${service.serverIp}` : null;

  return (
    <div className="border-t border-line px-4 sm:px-5 py-5 flex flex-col gap-5">
      {(sshCommand || service.sshPassword) && (
        <section aria-label="SSH access">
          <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">SSH access</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {sshCommand && (
              <Field label="Connect">
                <Mono>{sshCommand}</Mono>
                <CopyButton value={sshCommand} label="SSH command" />
              </Field>
            )}
            {service.sshPassword && (
              <Field label="Password">
                <Mono>{showPassword ? service.sshPassword : "•".repeat(14)}</Mono>
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-pressed={showPassword}
                  className="ml-auto text-xs font-medium text-link hover:underline cursor-pointer px-1.5 h-8"
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
                <CopyButton value={service.sshPassword} label="SSH password" />
              </Field>
            )}
          </div>
        </section>
      )}

      <section aria-label="Server details">
        <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">Details</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {service.ipv6Address && (
            <Field label="IPv6">
              <Mono>{service.ipv6Address}</Mono>
              <CopyButton value={service.ipv6Address} label="IPv6 address" />
            </Field>
          )}
          <Field label="Region">
            <span className="text-sm text-fg truncate">{getRegion(service.region)?.label ?? service.region}</span>
          </Field>
          {(os || preset) && (
            <Field label="Image">
              <span className="text-sm text-fg truncate">{[os, preset].filter(Boolean).join(" + ")}</span>
            </Field>
          )}
          <Field label="Created">
            <span className="text-sm text-fg">{formatDate(service.startDate)}</span>
          </Field>
        </div>
      </section>

      <AutopayPanel service={service} onChanged={onChanged} />

      <p className="text-xs text-fg-muted">
        Need a bigger plan or a different OS?{" "}
        <Link href="/dashboard/support" className="text-link hover:underline">
          Open a support ticket
        </Link>{" "}
        and we&apos;ll help.
      </p>
    </div>
  );
}

function ServerRow({ service, onChanged }: { service: Service; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const settingUp = SETTING_UP.includes(service.status);
  const canExpand = service.status === "ACTIVE" || service.status === "SUSPENDED";
  const name = service.hostname || service.plan.name;
  const detailsId = `server-${service.id}-details`;
  const progressHref =
    service.orderId && service.plan.slug
      ? `/order/${service.plan.slug}/provisioning?orderId=${service.orderId}&serviceId=${service.id}`
      : null;
  const inactive = service.status === "CANCELLED" || service.status === "DELETED";

  return (
    <li className={`bg-surface border border-line rounded-xl ${inactive ? "opacity-70" : ""}`}>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto_auto] md:items-center gap-x-6 gap-y-3 px-4 sm:px-5 py-4">
        {/* Identity */}
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h3 className="font-mono text-[15px] font-medium text-fg truncate">{name}</h3>
            <StatusBadge status={service.status} />
          </div>
          <p className="text-xs text-fg-muted mt-1 truncate">
            {service.plan.name} · {specLine(service.plan)}
          </p>
        </div>

        {/* IPv4 / progress */}
        <div className="min-w-0">
          {settingUp ? (
            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-fg-muted truncate">{service.provisioningStep || "Queued"}</span>
                <span className="text-link font-medium tabular-nums ml-2">{service.provisioningPct}%</span>
              </div>
              <div
                className="h-1.5 rounded-full bg-surface-2 overflow-hidden"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={service.provisioningPct}
                aria-label={`Setting up ${name}`}
              >
                <div className="h-full bg-link rounded-full transition-[width] duration-500" style={{ width: `${service.provisioningPct}%` }} />
              </div>
            </div>
          ) : !service.ready && service.status === "SUSPENDED" ? (
            <span className="text-sm text-fg-muted">Setting up</span>
          ) : service.serverIp ? (
            <div className="flex items-center gap-1">
              <span className="text-xs text-fg-muted md:hidden mr-1">IPv4</span>
              <code className="font-mono text-sm text-fg select-all">{service.serverIp}</code>
              <CopyButton value={service.serverIp} label={`IP address of ${name}`} />
            </div>
          ) : (
            <span className="text-sm text-fg-subtle">No IP</span>
          )}
        </div>

        {/* Billing */}
        <div className="text-xs md:text-right whitespace-nowrap">
          {service.status === "ACTIVE" || service.status === "SUSPENDED" ? (
            <>
              <p className="text-fg-muted">Paid until</p>
              <p className="text-fg text-sm">{formatDate(service.nextBillingDate)}</p>
            </>
          ) : null}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 md:justify-end">
          {settingUp && progressHref && (
            <Link href={progressHref}>
              <Button variant="secondary" size="sm">View progress</Button>
            </Link>
          )}
          {service.status === "FAILED" && (
            <Link href="/dashboard/support">
              <Button variant="secondary" size="sm">Contact support</Button>
            </Link>
          )}
          {service.panelUrl && service.ready && service.status === "ACTIVE" && (
            <a href={service.panelUrl} target="_blank" rel="noopener noreferrer">
              <Button variant="secondary" size="sm">
                Open panel
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                <span className="sr-only">(opens in a new tab)</span>
              </Button>
            </a>
          )}
          {canExpand && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={detailsId}
            >
              {open ? "Hide details" : "Manage"}
              <svg
                className={`w-4 h-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Button>
          )}
        </div>
      </div>

      {/* Attention callouts are visible without expanding */}
      {!open && needsAttention(service) && service.status !== "FAILED" && (
        <div className="px-4 sm:px-5 pb-4">
          <AutopayPanel service={service} onChanged={onChanged} />
        </div>
      )}
      {service.status === "FAILED" && (
        <p className="mx-4 sm:mx-5 mb-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          We couldn&apos;t finish setting up this server. Our team has been notified, and we&apos;ve emailed you about your refund.
        </p>
      )}

      {canExpand && open && (
        <div id={detailsId}>
          <ServerDetails service={service} onChanged={onChanged} />
        </div>
      )}
    </li>
  );
}

function RowSkeleton() {
  return (
    <li className="bg-surface border border-line rounded-xl px-5 py-4 flex items-center gap-6" aria-hidden>
      <div className="flex-1">
        <div className="h-4 w-40 rounded bg-surface-2 animate-pulse" />
        <div className="h-3 w-56 rounded bg-surface-2 animate-pulse mt-2" />
      </div>
      <div className="hidden md:block h-4 w-32 rounded bg-surface-2 animate-pulse" />
      <div className="hidden md:block h-8 w-24 rounded bg-surface-2 animate-pulse" />
    </li>
  );
}

export default function ServicesPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    return fetch("/api/services", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) throw new Error(d.error);
        setServices(d.data);
        setLoadError(false);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep progress bars live while anything is being set up.
  const anySettingUp = services.some((s) => SETTING_UP.includes(s.status));
  useEffect(() => {
    if (!anySettingUp) return;
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [anySettingUp, load]);

  const visible = services.filter((s) => s.status !== "DELETED");
  const q = query.trim().toLowerCase();
  const activeFilter = FILTERS.find((f) => f.key === filter)!;
  const shown = visible.filter(
    (s) =>
      activeFilter.match(s) &&
      (!q || [s.hostname, s.serverIp, s.plan.name].some((v) => v?.toLowerCase().includes(q)))
  );

  return (
    <div className="max-w-6xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-fg">
            Servers
            {!loading && visible.length > 0 && <span className="text-fg-muted font-normal"> · {visible.length}</span>}
          </h1>
          <p className="text-fg-muted text-sm mt-1">Your VPS and storage services, their IPs and billing.</p>
        </div>
        <Link href="/pricing" className="self-start sm:self-auto">
          <Button>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Deploy server
          </Button>
        </Link>
      </div>

      {loading ? (
        <ul className="flex flex-col gap-3" aria-busy="true" aria-label="Loading servers">
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </ul>
      ) : loadError && services.length === 0 ? (
        <div className="bg-surface border border-line rounded-xl p-10 text-center">
          <p className="text-fg font-medium mb-1">Couldn&apos;t load your servers</p>
          <p className="text-fg-muted text-sm mb-5">Check your connection and try again.</p>
          <Button variant="secondary" onClick={() => { setLoading(true); load(); }}>
            Try again
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-surface border border-line rounded-xl p-12 text-center">
          <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-link" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
            </svg>
          </div>
          <h2 className="text-fg font-semibold text-lg mb-1">No servers yet</h2>
          <p className="text-fg-muted text-sm mb-6">Deploy a VPS with root access in a few minutes.</p>
          <Link href="/pricing">
            <Button>See VPS plans</Button>
          </Link>
        </div>
      ) : (
        <>
          {/* Filters + search */}
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
            <div role="group" aria-label="Filter servers by status" className="flex gap-1 overflow-x-auto -mx-1 px-1">
              {FILTERS.map((f) => {
                const count = visible.filter(f.match).length;
                if (f.key !== "all" && count === 0) return null;
                const isActive = filter === f.key;
                return (
                  <button
                    key={f.key}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => setFilter(f.key)}
                    className={`flex items-center gap-2 h-9 px-3 rounded-lg text-sm font-medium whitespace-nowrap cursor-pointer transition-colors duration-150 ${
                      isActive ? "bg-surface-2 text-fg" : "text-fg-muted hover:text-fg hover:bg-surface"
                    }`}
                  >
                    {f.label}
                    <span
                      className={`text-xs tabular-nums px-1.5 rounded ${
                        f.key === "attention" ? "bg-warning/15 text-warning" : "bg-canvas text-fg-muted"
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="relative md:w-72">
              <label htmlFor="server-search" className="sr-only">
                Search servers
              </label>
              <svg className="w-4 h-4 text-fg-muted absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
              </svg>
              <input
                id="server-search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search hostname or IP"
                className="w-full h-9 pl-9 pr-3 rounded-lg bg-surface border border-line-strong text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:border-link"
              />
            </div>
          </div>

          {/* Column headings (desktop) */}
          <div className="hidden md:grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto_auto] gap-x-6 px-5 pb-2 text-xs font-medium text-fg-muted" aria-hidden>
            <span>Server</span>
            <span>IPv4</span>
            <span className="text-right">Billing</span>
            <span className="w-24" />
          </div>

          {shown.length === 0 ? (
            <div className="bg-surface border border-line rounded-xl p-10 text-center">
              <p className="text-fg-muted text-sm">
                No servers match {q ? <>&ldquo;{query}&rdquo;</> : "this filter"}.{" "}
                <button
                  type="button"
                  onClick={() => { setQuery(""); setFilter("all"); }}
                  className="text-link hover:underline cursor-pointer"
                >
                  Clear filters
                </button>
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {shown.map((service) => (
                <ServerRow key={service.id} service={service} onChanged={load} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
