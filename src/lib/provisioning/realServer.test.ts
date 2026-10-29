import { test } from "node:test";
import assert from "node:assert/strict";
import { provisioningRoute } from "../queue/provisioningQueue";
import { forCustomer, isActiveConstraintError, isRealServer, missingForActive } from "./serverReady";
import { planAvailability } from "./availability";
import { alertPaidWithoutContainer, type PaidOrder } from "./paidWithoutContainer";

// ── Routing: a live environment never runs the simulator ─────────────

test("live payments are never routed to the simulator — VPS goes to Proxmox, anything else is held for a person", () => {
  const prod = { APP_ENV: "production", PROVISIONER: "proxmox" };
  assert.equal(provisioningRoute("VPS", prod), "PROXMOX");
  assert.equal(provisioningRoute("STORAGE", prod), "HOLD");
  assert.equal(provisioningRoute("VPS", { RAZORPAY_KEY_ID: "rzp_live_1", PROVISIONER: "simulated" }), "HOLD");
  assert.equal(provisioningRoute("VPS", { RAZORPAY_KEY_ID: "rzp_test_1" }), "SIMULATE");
});

// ── ACTIVE means a real server ───────────────────────────────────────

const real = { status: "ACTIVE", serverSource: "PROXMOX", serverIp: "78.46.1.2", proxmoxVmId: "101", nodeId: "node_1", hetznerFloatingIpId: "555", sshVerifiedAt: new Date() };
const creds = { serverIp: "78.46.1.2", ipv6Address: "2a01::101", sshUsername: "userab12", sshPassword: "pw", panelUrl: "http://x", panelPassword: "pp" };

test("a real server needs a VM id, a node, a Floating IP and a passed SSH check", () => {
  assert.ok(isRealServer(real));
  assert.ok(isRealServer({ ...real, status: "SUSPENDED" }));
  assert.deepEqual(missingForActive({ serverSource: "PROXMOX", serverIp: null, proxmoxVmId: null, nodeId: null, hetznerFloatingIpId: null, sshVerifiedAt: null }), ["container (VM id)", "node", "Floating IP", "SSH check"]);
  for (const field of ["proxmoxVmId", "nodeId", "hetznerFloatingIpId", "sshVerifiedAt"] as const) {
    assert.equal(isRealServer({ ...real, [field]: null }), false, field);
  }
});

test("a manual server needs its IP and a passed SSH check — no container, node or Floating IP", () => {
  const manual = { status: "ACTIVE", serverSource: "MANUAL", serverIp: "203.0.113.7", proxmoxVmId: null, nodeId: null, hetznerFloatingIpId: null, sshVerifiedAt: new Date() };
  assert.ok(isRealServer(manual));
  assert.deepEqual(missingForActive({ ...manual, sshVerifiedAt: null }), ["SSH check"]);
  assert.deepEqual(missingForActive({ ...manual, serverIp: null, sshVerifiedAt: null }), ["server IP", "SSH check"]);
  assert.equal(forCustomer({ ...creds, ...manual, sshVerifiedAt: null }).serverIp, null, "not checked yet: Setting up");
  assert.equal(forCustomer({ ...creds, ...manual }).ready, true);
});

test("the simulator's ACTIVE row (fake IP, nothing else) is shown as Setting up with no IP or credentials", () => {
  const fake = { ...creds, serverIp: "19.157.157.231", status: "ACTIVE", serverSource: "PROXMOX", proxmoxVmId: null, nodeId: null, hetznerFloatingIpId: null, sshVerifiedAt: null };
  const shown = forCustomer(fake);
  assert.equal(shown.ready, false);
  assert.equal(shown.status, "INSTALLING");
  assert.deepEqual([shown.serverIp, shown.ipv6Address, shown.sshUsername, shown.sshPassword, shown.panelUrl, shown.panelPassword], [null, null, null, null, null, null]);

  const ok = forCustomer({ ...creds, ...real });
  assert.equal(ok.ready, true);
  assert.equal(ok.serverIp, "78.46.1.2");
});

test("recognises the database refusing a fake ACTIVE", () => {
  assert.ok(isActiveConstraintError(new Error('new row for relation "Service" violates check constraint "Service_active_requires_real_server"')));
  assert.equal(isActiveConstraintError(new Error("unique constraint")), false);
});

// ── Buy is hidden for plans no node can hold ─────────────────────────

const config = { ramOvercommit: 1, diskPoolReserveGB: 20 };
const cpx32 = { name: "sowsi-proxmox-01", status: "READY", physicalRamMB: 7940, physicalDiskGB: 150 };
const cpx42 = { ...cpx32, physicalRamMB: 15995, physicalDiskGB: 314 };
const plans = {
  basic: { category: "VPS", ramGB: 2, storageGB: 40 },
  pro: { category: "VPS", ramGB: 4, storageGB: 80 },
  elite: { category: "VPS", ramGB: 8, storageGB: 160 },
  dedicatedPro: { category: "VPS", ramGB: 16, storageGB: 320 },
  s4: { category: "STORAGE", ramGB: null, storageGB: 500 },
};

test("plans that fit no registered node (or have no automated provisioning) can't be bought", () => {
  const ok = (p: (typeof plans)[keyof typeof plans], nodes = [cpx32]) => planAvailability(p, nodes, config).orderable;
  assert.deepEqual([ok(plans.basic), ok(plans.pro), ok(plans.elite), ok(plans.dedicatedPro), ok(plans.s4)], [true, true, false, false, false]);
  // After rescaling the node to a CPX42: 8 GB / 160 GB fits, 16 GB / 320 GB still doesn't (measured RAM < 16384 MB, 294 GB usable).
  assert.deepEqual([ok(plans.elite, [cpx42]), ok(plans.dedicatedPro, [cpx42])], [true, false]);
  assert.equal(ok(plans.basic, []), false, "no node registered");
  assert.equal(ok(plans.basic, [{ ...cpx32, status: "DECOMMISSIONING" }]), false);
  const why = planAvailability(plans.elite, [cpx32], config);
  assert.ok(!why.orderable && /even when empty/.test(why.reason));
});

// ── Paid, but no container after 10 minutes ──────────────────────────

test("alerts once per paid service that has no container after 10 minutes", async () => {
  const now = new Date("2026-10-30T10:00:00Z");
  const order = (id: string, minutesAgo: number): PaidOrder => ({ serviceId: id, planName: "VPS Basic", customer: "Asha", status: "INSTALLING", provisioningStep: "Setting up", paidAt: new Date(now.getTime() - minutesAgo * 60_000) });
  const alerted = new Set<string>();
  const emails: string[] = [];
  let askedBefore: Date | null = null;
  const deps = {
    candidates: async (paidBefore: Date) => ((askedBefore = paidBefore), [order("svc_a", 30), order("svc_b", 12)].filter((o) => o.paidAt < paidBefore)),
    alreadyAlerted: async () => new Set(alerted),
    alertAdmin: async (subject: string) => void emails.push(subject),
    record: async (o: PaidOrder) => void alerted.add(o.serviceId),
  };
  assert.deepEqual(await alertPaidWithoutContainer(deps, now), { alerted: 2 });
  assert.equal(askedBefore!.toISOString(), "2026-10-30T09:50:00.000Z", "only orders paid 10+ minutes ago");
  assert.deepEqual(emails, ["2 paid orders have no server after 10 minutes"]);
  assert.deepEqual(await alertPaidWithoutContainer(deps, now), { alerted: 0 }, "not again on the next cron run");
  assert.equal(emails.length, 1);
});
