import { test } from "node:test";
import assert from "node:assert/strict";
import { executeReprovision, planReprovision, resetData, type ReprovisionDeps, type ReprovisionSnapshot } from "./reprovision";

const now = new Date("2026-10-30T10:00:00Z");

/** The live incident: ACTIVE at 0% with a fake IP, no VM id, no node, no Floating IP. */
function simulated(over: Partial<ReprovisionSnapshot> = {}): ReprovisionSnapshot {
  return {
    id: "svc_live",
    status: "INSTALLING", // moved off ACTIVE by the migration
    serverSource: "PROXMOX",
    provisioningPct: 0,
    provisioningStep: "Setting up — your server is being prepared",
    updatedAt: new Date("2026-10-29T08:00:00Z"),
    plan: { name: "VPS Basic", category: "VPS", ramGB: 2, storageGB: 40 },
    customer: "Asha <asha@example.com>",
    proxmoxVmId: null,
    nodeName: null,
    hetznerFloatingIpId: null,
    serverIp: "19.157.157.231",
    ipv6Address: null,
    credentials: { sshUsername: true, sshPassword: true, panelUrl: false, panelPassword: false },
    subscription: { razorpaySubscriptionId: "sub_live_1", dbStatus: "ACTIVE" },
    paymentStatuses: ["SUCCESS"],
    ...over,
  };
}

function fakes(opts: { snap?: ReprovisionSnapshot | null; containers?: string[]; ips?: string[]; rzp?: string; node?: string | null; resetOk?: boolean; endStatus?: string } = {}) {
  const calls: string[] = [];
  const logs: { action: string; dryRun?: boolean; success?: boolean }[] = [];
  let resetWith: unknown = null;
  const deps: ReprovisionDeps = {
    load: async () => (opts.snap === undefined ? simulated() : opts.snap),
    findContainers: async () => opts.containers ?? [],
    findFloatingIps: async () => opts.ips ?? [],
    razorpaySubscriptionStatus: async () => opts.rzp ?? "active",
    placement: async () => (opts.node === null ? { node: null, reason: "sowsi-proxmox-01 has 1024 MB RAM free, needs 2048 MB" } : { node: opts.node ?? "sowsi-proxmox-01" }),
    reset: async (_s, data) => {
      calls.push("reset");
      resetWith = data;
      return opts.resetOk ?? true;
    },
    provision: async () => void calls.push("provision"),
    result: async () => ({ status: opts.endStatus ?? "ACTIVE", provisioningStep: "Server is ready!", provisionError: opts.endStatus === "FAILED" ? "SSH timed out" : null, nodeName: "sowsi-proxmox-01", proxmoxVmId: "101", serverIp: "78.46.1.2" }),
    log: async (e) => void logs.push(e),
  };
  return { deps, calls, logs, resetWith: () => resetWith };
}

test("plan mode lists what it resets and builds — and changes nothing", async () => {
  const f = fakes();
  const r = await planReprovision("svc_live", f.deps, now);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const fields = Object.fromEntries(r.plan.changes.map((c) => [c.field, `${c.from} → ${c.to}`]));
  assert.equal(fields.status, "INSTALLING → PROVISIONING");
  assert.equal(fields.serverIp, "19.157.157.231 → —");
  assert.equal(fields.sshPassword, "(set) → —");
  assert.match(r.plan.build, /placed now → sowsi-proxmox-01.*NO refund, autopay untouched/);
  assert.deepEqual(f.calls, [], "no reset, no build");
});

test("the reset writes Service fields only — nothing about payments, subscriptions or refunds", () => {
  const keys = Object.keys(resetData()).sort();
  assert.deepEqual(keys, [
    "hetznerFloatingIpId",
    "ipv6Address",
    "nodeId",
    "panelPassword",
    "panelUrl",
    "provisionError",
    "provisioningPct",
    "provisioningStep",
    "proxmoxVmId",
    "serverIp",
    "sshPassword",
    "sshUsername",
    "sshVerifiedAt",
    "status",
    "waitingForNodeSince",
  ]);
  for (const k of keys) assert.doesNotMatch(k, /payment|subscription|refund|billing|amount/i);
});

test("refuses — and touches nothing — when a container or Floating IP already exists", async () => {
  for (const f of [fakes({ containers: ['vmid 101 "sowsi-svc_live" on sowsi-proxmox-01 (running)'] }), fakes({ ips: ["78.46.1.2 (id 555, assigned to server 168392011)"] })]) {
    const r = await executeReprovision("svc_live", f.deps, "sivakumar", now);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.refusals.join(" "), /already exists for it/);
    assert.deepEqual(f.calls, []);
    assert.equal(f.logs[0].action, "REPROVISION_REFUSED");
  }
});

test("refuses unless the Razorpay subscription is active", async () => {
  for (const [opts, why] of [
    [{ rzp: "halted" }, /"halted", not "active"/],
    [{ rzp: "cancelled" }, /"cancelled", not "active"/],
    [{ snap: simulated({ subscription: null }) }, /no Razorpay autopay subscription/],
  ] as const) {
    const f = fakes(opts);
    const r = await planReprovision("svc_live", f.deps, now);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.refusals.join(" "), why);
  }
});

test("refuses refunded, unpaid, non-VPS, cancelled, mid-build or unplaceable services", async () => {
  const cases: [Parameters<typeof fakes>[0], RegExp][] = [
    [{ snap: simulated({ paymentStatuses: ["REFUNDED"] }) }, /refunded/],
    [{ snap: simulated({ paymentStatuses: ["PENDING"] }) }, /no successful payment/],
    [{ snap: simulated({ plan: { name: "S4 Basic", category: "STORAGE", ramGB: null, storageGB: 500 } }) }, /only VPS plans/],
    [{ snap: simulated({ status: "CANCELLED" }) }, /status is CANCELLED/],
    [{ snap: simulated({ status: "INSTALLING", provisioningPct: 60, updatedAt: new Date(now.getTime() - 5 * 60_000) }) }, /build looks like it's running/],
    [{ node: null }, /no node can hold it now.*nothing would be built/],
    [{ snap: null }, /not found/],
    [{ snap: simulated({ serverSource: "MANUAL" }) }, /manual server/],
  ];
  for (const [opts, why] of cases) {
    const f = fakes(opts);
    const r = await executeReprovision("svc_live", f.deps, "sivakumar", now);
    assert.equal(r.ok, false, String(why));
    if (!r.ok) assert.match(r.refusals.join(" "), why);
    assert.deepEqual(f.calls, [], String(why));
  }
});

test("execute: resets, runs the real build, logs start and finish", async () => {
  const f = fakes();
  const r = await executeReprovision("svc_live", f.deps, "sivakumar", now);
  assert.deepEqual(r, { ok: true, status: "ACTIVE", detail: "ACTIVE on sowsi-proxmox-01 as container 101, IP 78.46.1.2" });
  assert.deepEqual(f.calls, ["reset", "provision"]);
  assert.deepEqual(f.resetWith(), resetData());
  assert.deepEqual(f.logs.map((l) => [l.action, l.success ?? true]), [
    ["REPROVISION_STARTED", true],
    ["REPROVISION_FINISHED", true],
  ]);
});

test("execute: a failed build is logged as a failure (provisionVPS released resources, no refund)", async () => {
  const f = fakes({ endStatus: "FAILED" });
  const r = await executeReprovision("svc_live", f.deps, "sivakumar", now);
  assert.deepEqual(r, { ok: true, status: "FAILED", detail: "FAILED: SSH timed out" });
  assert.equal(f.logs.at(-1)?.success, false);
});

test("execute: if the service changed between check and reset, nothing is built", async () => {
  const f = fakes({ resetOk: false });
  const r = await executeReprovision("svc_live", f.deps, "sivakumar", now);
  assert.equal(r.ok, false);
  assert.deepEqual(f.calls, ["reset"]);
});

test("an old FAILED service whose payment stands can be rebuilt", async () => {
  const f = fakes({ snap: simulated({ status: "FAILED", provisioningStep: "Provisioning failed" }) });
  assert.equal((await planReprovision("svc_live", f.deps, now)).ok, true);
});
