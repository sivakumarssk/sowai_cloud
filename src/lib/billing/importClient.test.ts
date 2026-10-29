import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLinks, IMPORTED_STEP, planImport, type ClientBundle, type ImportTarget } from "./importClient";

/** The real client in the old database: one autopay order, "fulfilled" by the simulator. */
function client(): ClientBundle {
  return {
    user: { id: "usr_1", email: "client@example.com", password: "$2a$12$hash", name: "Client", phone: "9000000000", role: "CLIENT", isVerified: true, resetToken: "tok", createdAt: new Date("2026-10-01") },
    orders: [{ id: "ord_1", userId: "usr_1", planId: "VPS_VPS_BASIC", status: "PAID", billingCycle: 1, addons: [], amount: 129900, gstAmount: 0, processingFee: 3066, quote: null }],
    services: [
      {
        id: "svc_1", userId: "usr_1", planId: "VPS_VPS_BASIC", orderId: "ord_1", status: "INSTALLING", provisioningStep: "Setting up", provisioningPct: 0,
        serverIp: "19.157.157.231", sshUsername: "enc:root", sshPassword: "enc:pw", proxmoxVmId: null, nodeId: "node_dev", hetznerFloatingIpId: null,
        nextBillingDate: new Date("2026-11-29"), startDate: new Date("2026-10-29"),
      },
    ],
    subscriptions: [{ id: "sub_row_1", userId: "usr_1", serviceId: "svc_1", orderId: "ord_1", razorpaySubscriptionId: "sub_LiveABC", razorpayPlanId: "plan_X", status: "ACTIVE", billingCycle: 1, amount: 129900, gstAmount: 0, paidCount: 1 }],
    payments: [{ id: "pay_row_1", userId: "usr_1", serviceId: "svc_1", orderId: "ord_1", subscriptionId: "sub_row_1", amount: 129900, razorpayPaymentId: "pay_LiveXYZ", status: "SUCCESS", invoiceNumber: "INV-1" }],
  };
}

const slugs = new Map([["VPS_VPS_BASIC", "VPS_BASIC"]]);
const target = (over: Partial<ImportTarget["existing"]> = {}, planIdBySlug = new Map([["VPS_BASIC", "VPS_VPS_BASIC"]])): ImportTarget => ({
  planIdBySlug,
  existing: { userEmail: false, ids: new Set(), razorpayIds: new Set(), ...over },
});

test("copies the rows with their ids and Razorpay ids; the service becomes a manual server on billing hold", () => {
  const r = planImport(client(), slugs, target());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const [svc] = r.rows.services;
  assert.equal(svc.id, "svc_1");
  assert.equal(svc.serverSource, "MANUAL");
  assert.equal(svc.billingHold, true);
  assert.equal(svc.status, "INSTALLING");
  assert.equal(svc.provisioningStep, IMPORTED_STEP);
  // The old database's server details don't come along (fake IP, unknown node).
  for (const k of ["serverIp", "sshUsername", "sshPassword", "nodeId", "proxmoxVmId"]) assert.equal(svc[k], undefined, k);
  assert.equal(svc.nextBillingDate instanceof Date && svc.nextBillingDate.toISOString(), "2026-11-29T00:00:00.000Z", "billing dates unchanged");

  assert.equal(r.rows.subscriptions[0].razorpaySubscriptionId, "sub_LiveABC");
  assert.equal(r.rows.subscriptions[0].status, "ACTIVE");
  assert.deepEqual(r.rows.payments[0], client().payments[0], "payments copied exactly");
  assert.equal(r.rows.user.password, "$2a$12$hash", "same password");
  assert.equal(r.rows.user.resetToken, undefined, "no reset token");
  assert.equal(r.rows.orders[0].quote, undefined, "null JSON left to the default");
  assert.match(r.notes.join(), /not copied.*serverIp.*nodeId/);
});

test("plans are matched by slug", () => {
  const r = planImport(client(), slugs, target({}, new Map([["VPS_BASIC", "plan_prod_basic"]])));
  assert.ok(r.ok && r.rows.orders[0].planId === "plan_prod_basic" && r.rows.services[0].planId === "plan_prod_basic");
  const missing = planImport(client(), slugs, target({}, new Map()));
  assert.ok(!missing.ok && /VPS_BASIC, which doesn't exist here — run scripts\/prod\/seed.ts/.test(missing.refusals.join()));
  const noSlug = planImport(client(), new Map([["VPS_VPS_BASIC", null]]), target());
  assert.ok(!noSlug.ok && /no slug/.test(noSlug.refusals.join()));
});

test("refuses instead of overwriting anything that already exists here", () => {
  const cases: [Partial<ImportTarget["existing"]>, RegExp][] = [
    [{ userEmail: true }, /already has an account/],
    [{ ids: new Set(["svc_1"]) }, /ids already exist here: svc_1/],
    [{ razorpayIds: new Set(["sub_LiveABC"]) }, /Razorpay ids .* already exist here: sub_LiveABC/],
    [{ razorpayIds: new Set(["pay_LiveXYZ"]) }, /pay_LiveXYZ/],
  ];
  for (const [existing, why] of cases) {
    const r = planImport(client(), slugs, target(existing));
    assert.ok(!r.ok && why.test(r.refusals.join()), String(why));
  }
});

test("an admin in the source is imported as a client", () => {
  const b = client();
  b.user.role = "ADMIN";
  const r = planImport(b, slugs, target());
  assert.ok(r.ok && r.rows.user.role === "CLIENT" && /imported as a client/.test(r.notes.join()));
});

test("the subscription id resolves to the user, service, order and payments", () => {
  const r = planImport(client(), slugs, target());
  assert.ok(r.ok);
  if (!r.ok) return;
  const [check] = checkLinks(r.rows);
  assert.equal(check.razorpaySubscriptionId, "sub_LiveABC");
  assert.ok(check.lines.every((l) => l.ok), JSON.stringify(check.lines));
  assert.match(check.lines.map((l) => l.text).join("\n"), /service +svc_1 INSTALLING · MANUAL · billingHold on[\s\S]*payments +1: pay_LiveXYZ SUCCESS/);
});

test("an abandoned checkout (never paid, no service) isn't a broken link; a paid one without a service is", () => {
  const b = client();
  b.subscriptions[0].serviceId = null;
  b.payments[0].status = "PENDING";
  assert.ok(checkLinks(b)[0].lines.every((l) => l.ok));
  b.payments[0].status = "SUCCESS";
  assert.match(checkLinks(b)[0].lines.filter((l) => !l.ok).map((l) => l.text).join(), /none linked — a renewal would have no server/);
});

test("the check flags broken links", () => {
  const b = client();
  b.subscriptions[0].serviceId = "svc_missing";
  b.payments[0].subscriptionId = "other";
  const [check] = checkLinks(b);
  const bad = check.lines.filter((l) => !l.ok).map((l) => l.text).join("\n");
  assert.match(bad, /service +svc_missing — MISSING/);
  assert.match(bad, /payments +0 — none linked/);
});
