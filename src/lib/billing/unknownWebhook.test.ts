import { test } from "node:test";
import assert from "node:assert/strict";
import { describeUnknown, reportUnknownWebhook, unknownKey, type UnknownWebhook } from "./unknownWebhook";

const charged: UnknownWebhook = {
  event: "subscription.charged",
  kind: "subscription",
  ids: { subscriptionId: "sub_Live123", paymentId: "pay_Abc", orderId: "order_Xyz", invoiceId: "inv_1", customerId: "cust_9", planId: "plan_7" },
  amountPaise: 152900,
  status: "active",
  email: "client@example.com",
};

function fakes(opts: { failAlert?: boolean } = {}) {
  const logged = new Set<string>();
  const mails: { subject: string; detail: string }[] = [];
  return {
    logged,
    mails,
    deps: {
      alreadyReported: async (key: string) => logged.has(key),
      log: async (key: string) => void logged.add(key),
      alertAdmin: async (subject: string, detail: string) => {
        if (opts.failAlert) throw new Error("mail down");
        mails.push({ subject, detail });
      },
    },
  };
}

test("an unknown subscription is logged and emailed with every Razorpay id", async () => {
  const f = fakes();
  assert.equal(await reportUnknownWebhook(f.deps, charged), "reported");
  assert.equal(f.logged.size, 1);
  assert.equal(f.mails.length, 1);
  assert.equal(f.mails[0].subject, "Razorpay webhook for an unknown subscription: sub_Live123");
  for (const id of ["sub_Live123", "pay_Abc", "order_Xyz", "inv_1", "cust_9", "plan_7", "₹1,529", "client@example.com"]) {
    assert.ok(f.mails[0].detail.includes(id), id);
  }
  assert.match(f.mails[0].detail, /Nothing was changed; the webhook was answered 200/);
});

test("a redelivered webhook is reported once; a different event about the same subscription is reported again", async () => {
  const f = fakes();
  await reportUnknownWebhook(f.deps, charged);
  assert.equal(await reportUnknownWebhook(f.deps, charged), "duplicate");
  assert.equal(await reportUnknownWebhook(f.deps, { ...charged, event: "subscription.halted", ids: { subscriptionId: "sub_Live123" } }), "reported");
  assert.equal(f.mails.length, 2);
  assert.notEqual(unknownKey(charged), unknownKey({ ...charged, ids: { ...charged.ids, paymentId: "pay_Next" } }), "next month's charge is a new report");
});

test("unknown orders and payments from payment.captured", () => {
  const order = describeUnknown({ event: "payment.captured", kind: "order", ids: { paymentId: "pay_1", orderId: "order_1" }, amountPaise: 59900 });
  assert.equal(order.subject, "Razorpay webhook for an unknown order: order_1");
  assert.match(order.detail, /pay_1/);
  assert.equal(describeUnknown({ event: "payment.captured", kind: "payment", ids: { paymentId: "pay_2", orderId: "order_2" } }).subject, "Razorpay webhook for an unknown payment: pay_2");
});

test("never throws — the webhook must still answer 200 when email or the database fails", async () => {
  assert.equal(await reportUnknownWebhook(fakes({ failAlert: true }).deps, charged), "failed");
  const broken = { ...fakes().deps, alreadyReported: async () => Promise.reject(new Error("db down")) };
  assert.equal(await reportUnknownWebhook(broken, charged), "failed");
});
