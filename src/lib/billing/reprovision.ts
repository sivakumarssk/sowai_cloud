// Rebuilding a paid service that has no real server (e.g. one "fulfilled" by
// the simulator). Plan first; execute only when every check passes.
//
// Never touches the Payment rows, the Subscription rows, Razorpay or refunds:
// the only write is to the Service fields listed in resetData(), then the real
// provisionVPS runs with node placement — and refundOnFailure: false.

export type ReprovisionSnapshot = {
  id: string;
  status: string;
  provisioningPct: number;
  provisioningStep: string | null;
  updatedAt: Date;
  plan: { name: string; category: string; ramGB: number | null; storageGB: number | null };
  customer: string;
  proxmoxVmId: string | null;
  nodeName: string | null;
  hetznerFloatingIpId: string | null;
  serverIp: string | null;
  ipv6Address: string | null;
  credentials: { sshUsername: boolean; sshPassword: boolean; panelUrl: boolean; panelPassword: boolean };
  /** Newest autopay subscription for the service. */
  subscription: { razorpaySubscriptionId: string; dbStatus: string } | null;
  /** Statuses of the service's payments (read only). */
  paymentStatuses: string[];
};

export type ReprovisionDeps = {
  load(serviceId: string): Promise<ReprovisionSnapshot | null>;
  /** Containers that exist for it anywhere (by its vmid on its node, or named sowsi-<id> on any node). */
  findContainers(s: ReprovisionSnapshot): Promise<string[]>;
  /** Floating IPs that exist for it (by its stored id, or labelled sowsi-<id>). */
  findFloatingIps(s: ReprovisionSnapshot): Promise<string[]>;
  /** Read-only status at Razorpay ("active", "halted", …). */
  razorpaySubscriptionStatus(razorpaySubscriptionId: string): Promise<string>;
  /** Where node placement would put it right now. */
  placement(need: { ramMB: number; diskGB: number }): Promise<{ node: string } | { node: null; reason: string }>;
  /** Writes resetData() — only if the service is still exactly as loaded (status + updatedAt). */
  reset(s: ReprovisionSnapshot, data: ResetData): Promise<boolean>;
  /** The real provisionVPS with node placement, refundOnFailure: false. */
  provision(serviceId: string): Promise<void>;
  result(serviceId: string): Promise<{ status: string; provisioningStep: string | null; provisionError: string | null; nodeName: string | null; proxmoxVmId: string | null; serverIp: string | null }>;
  log(entry: { action: string; serviceId: string; before?: unknown; after?: unknown; dryRun?: boolean; success?: boolean; error?: string }): Promise<void>;
};

/** Every Service field the rebuild changes. Nothing else is written, anywhere. */
export function resetData() {
  return {
    status: "PROVISIONING" as const,
    provisioningStep: "Starting...",
    provisioningPct: 0,
    provisionError: null,
    serverIp: null,
    ipv6Address: null,
    sshUsername: null,
    sshPassword: null,
    panelUrl: null,
    panelPassword: null,
    sshVerifiedAt: null,
    // These point at resources the checks proved don't exist; placement picks the node again.
    proxmoxVmId: null,
    hetznerFloatingIpId: null,
    nodeId: null,
    waitingForNodeSince: null,
  };
}
export type ResetData = ReturnType<typeof resetData>;

const REBUILDABLE = new Set(["ACTIVE", "INSTALLING", "PROVISIONING", "FAILED"]);
const BUILD_RUNNING_MS = 30 * 60_000;

export type ReprovisionPlan = {
  snapshot: ReprovisionSnapshot;
  changes: { field: string; from: string; to: string }[];
  build: string;
};

export type PlanResult = { ok: true; plan: ReprovisionPlan } | { ok: false; refusals: string[] };

const shown = (v: string | null | boolean) => (v === null || v === false ? "—" : v === true ? "(set)" : v);

/** Checks everything and describes the rebuild. Changes nothing. */
export async function planReprovision(serviceId: string, deps: ReprovisionDeps, now = new Date()): Promise<PlanResult> {
  const s = await deps.load(serviceId);
  if (!s) return { ok: false, refusals: [`service ${serviceId} not found`] };

  const refusals: string[] = [];
  if (s.plan.category !== "VPS") refusals.push(`${s.plan.name} is a ${s.plan.category} plan — only VPS plans can be built automatically`);
  if (!REBUILDABLE.has(s.status)) refusals.push(`status is ${s.status} — only ACTIVE, INSTALLING, PROVISIONING or FAILED services are rebuilt`);
  if (!s.paymentStatuses.includes("SUCCESS")) {
    refusals.push(
      s.paymentStatuses.includes("REFUNDED")
        ? "its payment was refunded — rebuilding would hand out a server nobody paid for"
        : "it has no successful payment"
    );
  }
  const midBuild = (s.status === "PROVISIONING" || s.status === "INSTALLING") && s.provisioningPct > 0 && s.provisioningPct < 100;
  if (midBuild && now.getTime() - s.updatedAt.getTime() < BUILD_RUNNING_MS) {
    refusals.push(`a build looks like it's running (${s.provisioningPct}% — "${s.provisioningStep}", updated ${s.updatedAt.toISOString()})`);
  }

  const [containers, ips] = await Promise.all([deps.findContainers(s), deps.findFloatingIps(s)]);
  for (const c of containers) refusals.push(`a container already exists for it: ${c}`);
  for (const ip of ips) refusals.push(`a Floating IP already exists for it: ${ip}`);

  if (!s.subscription) {
    refusals.push("it has no Razorpay autopay subscription");
  } else {
    const status = await deps.razorpaySubscriptionStatus(s.subscription.razorpaySubscriptionId).catch((e: Error) => `unknown (${e.message})`);
    if (status !== "active") refusals.push(`Razorpay subscription ${s.subscription.razorpaySubscriptionId} is "${status}", not "active"`);
  }

  const need = { ramMB: (s.plan.ramGB ?? 0) * 1024, diskGB: s.plan.storageGB ?? 0 };
  const placement = await deps.placement(need);
  if (placement.node === null) refusals.push(`no node can hold it now (${placement.reason}) — nothing would be built`);

  if (refusals.length > 0) return { ok: false, refusals };

  const data = resetData();
  const current: Record<keyof ResetData, string | null | boolean> = {
    status: s.status,
    provisioningStep: s.provisioningStep,
    provisioningPct: String(s.provisioningPct),
    provisionError: null,
    serverIp: s.serverIp,
    ipv6Address: s.ipv6Address,
    sshUsername: s.credentials.sshUsername,
    sshPassword: s.credentials.sshPassword,
    panelUrl: s.credentials.panelUrl,
    panelPassword: s.credentials.panelPassword,
    sshVerifiedAt: null,
    proxmoxVmId: s.proxmoxVmId,
    hetznerFloatingIpId: s.hetznerFloatingIpId,
    nodeId: s.nodeName,
    waitingForNodeSince: null,
  };
  const changes = (Object.keys(data) as (keyof ResetData)[])
    .map((field) => ({ field, from: shown(current[field]), to: shown(data[field] === null ? null : String(data[field])) }))
    .filter((c) => c.from !== c.to);

  return {
    ok: true,
    plan: {
      snapshot: s,
      changes,
      build: `real provisionVPS: ${s.plan.name} (${need.ramMB} MB / ${need.diskGB} GB) placed now → ${placement.node}; Floating IP in that node's location; SSH check before ACTIVE. On failure: what was bought is released, status FAILED, NO refund, autopay untouched, admin alerted.`,
    },
  };
}

export type ExecuteResult =
  | { ok: false; refusals: string[] }
  | { ok: true; status: string; detail: string };

/** Re-checks, resets the listed fields, runs the real build, and logs each step to EngineLog. */
export async function executeReprovision(serviceId: string, deps: ReprovisionDeps, by: string, now = new Date()): Promise<ExecuteResult> {
  const planned = await planReprovision(serviceId, deps, now);
  if (!planned.ok) {
    await deps.log({ action: "REPROVISION_REFUSED", serviceId, after: { refusals: planned.refusals, by }, dryRun: true, success: false, error: planned.refusals.join("; ") });
    return planned;
  }
  const { snapshot: s, changes } = planned.plan;
  const before = { status: s.status, provisioningStep: s.provisioningStep, provisioningPct: s.provisioningPct, serverIp: s.serverIp, ipv6Address: s.ipv6Address, proxmoxVmId: s.proxmoxVmId, node: s.nodeName, hetznerFloatingIpId: s.hetznerFloatingIpId };

  if (!(await deps.reset(s, resetData()))) {
    const why = "the service changed while it was being checked — nothing reset; run it again";
    await deps.log({ action: "REPROVISION_REFUSED", serviceId, before, after: { by }, success: false, error: why });
    return { ok: false, refusals: [why] };
  }
  await deps.log({ action: "REPROVISION_STARTED", serviceId, before, after: { by, reset: changes.map((c) => c.field) } });

  await deps.provision(serviceId);
  const r = await deps.result(serviceId);
  const success = r.status === "ACTIVE";
  const detail =
    r.status === "ACTIVE"
      ? `ACTIVE on ${r.nodeName} as container ${r.proxmoxVmId}, IP ${r.serverIp}`
      : r.status === "PROVISIONING"
        ? `queued: ${r.provisioningStep} (no node had room at build time)`
        : `${r.status}: ${r.provisionError ?? r.provisioningStep ?? "unknown"}`;
  await deps.log({ action: "REPROVISION_FINISHED", serviceId, before, after: { by, ...r }, success, error: success ? undefined : detail });
  return { ok: true, status: r.status, detail };
}
