"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { StatusBadge, type ServiceStatus } from "@/components/ui/StatusBadge";
import { showToast } from "@/components/ui/Toast";

interface AssignService {
  id: string;
  status: ServiceStatus;
  serverSource: "PROXMOX" | "MANUAL";
  billingHold: boolean;
  provisioningStep: string | null;
  nextBillingDate: string;
  serverIp: string | null;
  ipv6Address: string | null;
  sshUsername: string | null;
  panelUrl: string | null;
  sshVerifiedAt: string | null;
  proxmoxVmId: string | null;
  user: { name: string; email: string };
  plan: { name: string; category: string };
  subscription: { razorpaySubscriptionId: string; status: string } | null;
  /** Why a server can't be assigned right now (null = it can). */
  refusal: string | null;
}

interface AuditRow {
  id: string;
  action: string;
  after: Record<string, unknown> | null;
  success: boolean;
  error: string | null;
  createdAt: string;
}

const ACTION_LABEL: Record<string, string> = {
  CLIENT_IMPORTED: "Imported from the old database",
  SERVER_ASSIGNED: "Server assigned (SSH check passed)",
  SERVER_ASSIGN_SSH_FAILED: "SSH check failed — nothing changed",
  SERVER_ASSIGN_REFUSED: "Assignment refused",
  BILLING_HOLD_SET: "Billing hold set",
  BILLING_HOLD_RELEASED: "Billing hold released",
  PAID_NO_CONTAINER: "Alert: paid, no server after 10 minutes",
};

const emptyForm = { serverIp: "", ipv6Address: "", sshPort: "22", sshUsername: "root", sshPassword: "", panelUrl: "", panelPassword: "", notifyCustomer: true };
async function fetchAssign(id: string) {
  const res = await fetch(`/api/admin/services/${id}/assign-server`).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  return res?.ok ? { ok: true, service: body.data.service as AssignService, audit: body.data.audit as AuditRow[] } : { ok: false, error: body.error as string | undefined };
}

const dateTime = (d: string) => new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export default function AssignServerPage() {
  const { id } = useParams<{ id: string }>();
  const [service, setService] = useState<AssignService | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const apply = useCallback((data: { ok: boolean; error?: string; service?: AssignService; audit?: AuditRow[] }) => {
    if (!data.ok || !data.service) return setLoadError(data.error || "Could not load the service");
    const s = data.service;
    setService(s);
    setAudit(data.audit ?? []);
    setForm((f) => ({ ...f, serverIp: f.serverIp || s.serverIp || "", sshUsername: s.sshUsername || f.sshUsername }));
  }, []);
  const load = useCallback(() => fetchAssign(id).then(apply), [id, apply]);

  useEffect(() => {
    fetchAssign(id).then(apply);
  }, [id, apply]);

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  function assign(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/services/${id}/assign-server`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setResult({ ok: true, text: `${data.data.status === "ACTIVE" ? "Running" : "Assigned (still suspended)"} — ${data.data.sshDetail}` });
        setForm((f) => ({ ...f, sshPassword: "", panelPassword: "" }));
        showToast("Server assigned", "success");
      } else {
        setResult({ ok: false, text: data.error || "Assignment failed" });
      }
      await load();
    });
  }

  function setHold(hold: boolean) {
    startTransition(async () => {
      const res = await fetch(`/api/admin/services/${id}/billing-hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hold }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) showToast(hold ? "Billing hold set" : "Billing hold released", "success");
      else showToast(data.error || "Could not change the billing hold", "error");
      await load();
    });
  }

  if (loadError) {
    return (
      <div className="rounded-lg border px-4 py-3 text-sm bg-danger/10 border-danger/30 text-danger" role="alert">
        {loadError}
      </div>
    );
  }
  if (!service) {
    return (
      <div className="flex items-center justify-center py-24" aria-label="Loading">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const blocked = service.refusal;

  return (
    <div className="max-w-3xl">
      <Link href="/admin/servers" className="text-link text-sm hover:underline">
        ← Servers
      </Link>
      <div className="mt-3 mb-6">
        <h1 className="text-2xl font-bold text-fg">Assign server</h1>
        <p className="text-fg-muted text-sm mt-1">
          For a server set up by hand. It is shown to the client as running only after an SSH login with these details succeeds.
        </p>
      </div>

      <section className="bg-surface border border-line rounded-xl p-5 mb-6" aria-label="Service">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-fg font-medium">
              {service.user.name} · {service.plan.name}
            </p>
            <p className="text-fg-muted text-xs">{service.user.email}</p>
          </div>
          <StatusBadge status={service.status} />
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4 text-sm">
          <div className="bg-canvas rounded-lg p-3">
            <dt className="text-fg-muted text-xs">Server</dt>
            <dd className="text-fg font-mono">
              {service.serverIp && service.sshVerifiedAt ? service.serverIp : "None yet"}
              <span className="text-fg-muted font-sans"> · {service.serverSource === "MANUAL" ? "manual" : "Proxmox"}</span>
            </dd>
          </div>
          <div className="bg-canvas rounded-lg p-3">
            <dt className="text-fg-muted text-xs">Autopay</dt>
            <dd className="text-fg font-mono">
              {service.subscription ? `${service.subscription.razorpaySubscriptionId} · ${service.subscription.status}` : "None"}
            </dd>
          </div>
          <div className="bg-canvas rounded-lg p-3">
            <dt className="text-fg-muted text-xs">Paid until</dt>
            <dd className="text-fg">{new Date(service.nextBillingDate).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}</dd>
          </div>
          <div className="bg-canvas rounded-lg p-3">
            <dt className="text-fg-muted text-xs">Last SSH check</dt>
            <dd className="text-fg">{service.sshVerifiedAt ? dateTime(service.sshVerifiedAt) : "Never"}</dd>
          </div>
        </dl>

        <div
          className={`mt-4 rounded-lg border px-4 py-3 text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
            service.billingHold ? "bg-warning/10 border-warning/30 text-warning" : "bg-surface-2 border-line-strong text-fg"
          }`}
        >
          <p>
            {service.billingHold
              ? "Billing hold is on: this service is never suspended or deleted automatically. Payments and autopay renewals are still recorded."
              : "Billing hold is off: missed payments suspend this service automatically, as for every client."}
          </p>
          <Button variant="secondary" size="sm" loading={isPending} onClick={() => setHold(!service.billingHold)}>
            {service.billingHold ? "Release hold" : "Set hold"}
          </Button>
        </div>
      </section>

      <form onSubmit={assign} className="bg-surface border border-line rounded-xl p-5 mb-6" aria-label="Server details">
        <h2 className="text-fg font-semibold mb-4">Server details</h2>
        {blocked && (
          <div className="mb-4 rounded-lg border px-4 py-3 text-sm bg-warning/10 border-warning/30 text-warning" role="status">
            Can&apos;t assign a server: {blocked}.
          </div>
        )}
        <fieldset disabled={Boolean(blocked) || isPending} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Server IP" placeholder="203.0.113.10" value={form.serverIp} onChange={set("serverIp")} required inputMode="decimal" autoComplete="off" />
          <Input label="IPv6 address (optional)" placeholder="2a01:4f8::10" value={form.ipv6Address} onChange={set("ipv6Address")} autoComplete="off" />
          <Input label="SSH username" value={form.sshUsername} onChange={set("sshUsername")} required autoComplete="off" />
          <Input label="SSH port" value={form.sshPort} onChange={set("sshPort")} inputMode="numeric" autoComplete="off" />
          <Input
            label="SSH password"
            type="password"
            value={form.sshPassword}
            onChange={set("sshPassword")}
            required
            autoComplete="new-password"
            hint="Used for the SSH check, then stored encrypted and shown to the client."
          />
          <div />
          <Input label="Panel URL (optional)" placeholder="https://panel.example.com" value={form.panelUrl} onChange={set("panelUrl")} autoComplete="off" />
          <Input label="Panel password (optional)" type="password" value={form.panelPassword} onChange={set("panelPassword")} autoComplete="new-password" />
          <label className="sm:col-span-2 flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={form.notifyCustomer} onChange={set("notifyCustomer")} className="w-4 h-4 accent-primary" />
            Email the client their login when the check passes
          </label>
        </fieldset>

        {result && (
          <div
            className={`mt-4 rounded-lg border px-4 py-3 text-sm ${result.ok ? "bg-success/10 border-success/30 text-success" : "bg-danger/10 border-danger/30 text-danger"}`}
            role={result.ok ? "status" : "alert"}
          >
            {result.text}
          </div>
        )}

        <div className="mt-5 flex flex-col sm:flex-row sm:items-center gap-3">
          <Button type="submit" loading={isPending} disabled={Boolean(blocked)}>
            Check SSH and assign
          </Button>
          <p className="text-fg-muted text-xs">Logs in once (15 s timeout). Nothing changes unless the login works.</p>
        </div>
      </form>

      <section className="bg-surface border border-line rounded-xl p-5" aria-label="Audit log">
        <h2 className="text-fg font-semibold mb-3">Audit log</h2>
        {audit.length === 0 ? (
          <p className="text-fg-muted text-sm">Nothing yet.</p>
        ) : (
          <ol className="divide-y divide-line">
            {audit.map((a) => (
              <li key={a.id} className="py-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className={a.success ? "text-fg" : "text-danger"}>{ACTION_LABEL[a.action] ?? a.action}</span>
                  <time className="text-fg-muted text-xs" dateTime={a.createdAt}>
                    {dateTime(a.createdAt)}
                  </time>
                </div>
                <p className="text-fg-muted text-xs mt-1 font-mono break-all">
                  {[
                    typeof a.after?.by === "string" && `by ${a.after.by}`,
                    typeof a.after?.serverIp === "string" && `${a.after.sshUsername ?? ""}@${a.after.serverIp}:${a.after.sshPort ?? 22}`,
                    typeof a.after?.ssh === "string" && a.after.ssh,
                    a.error,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
