// A Razorpay webhook about a subscription, payment or order this database has
// never seen — e.g. a client whose rows still live in another database. It is
// logged and emailed to an admin with every Razorpay id, and the webhook still
// answers 200: a 5xx would make Razorpay retry for a day and then disable the
// webhook for everyone. Nothing is created, charged, cancelled or refunded.

export type UnknownKind = "subscription" | "payment" | "order";

export type UnknownWebhook = {
  event: string;
  kind: UnknownKind;
  /** Razorpay ids from the payload (whichever are present). */
  ids: { subscriptionId?: string | null; paymentId?: string | null; orderId?: string | null; invoiceId?: string | null; customerId?: string | null; planId?: string | null };
  /** In paise, when the payload has one. */
  amountPaise?: number | null;
  status?: string | null;
  email?: string | null;
};

export type UnknownWebhookDeps = {
  /** True when this exact delivery (same event and ids) was already reported. */
  alreadyReported(key: string): Promise<boolean>;
  log(key: string, u: UnknownWebhook): Promise<void>;
  alertAdmin(subject: string, detail: string): Promise<void>;
};

export const UNKNOWN_WEBHOOK_ACTION = "WEBHOOK_UNKNOWN";

/** Same event about the same ids = one report, however often Razorpay redelivers it. */
export function unknownKey(u: UnknownWebhook): string {
  const { subscriptionId, paymentId, orderId, invoiceId } = u.ids;
  return [u.event, u.kind, subscriptionId ?? "", paymentId ?? "", orderId ?? "", invoiceId ?? ""].join("|");
}

export function describeUnknown(u: UnknownWebhook): { subject: string; detail: string } {
  const id = u.kind === "subscription" ? u.ids.subscriptionId : u.kind === "payment" ? u.ids.paymentId : u.ids.orderId;
  const rows = [
    ["Event", u.event],
    ["Subscription", u.ids.subscriptionId],
    ["Payment", u.ids.paymentId],
    ["Order", u.ids.orderId],
    ["Invoice", u.ids.invoiceId],
    ["Customer", u.ids.customerId],
    ["Plan", u.ids.planId],
    ["Amount", u.amountPaise != null ? `₹${(u.amountPaise / 100).toLocaleString("en-IN")} (${u.amountPaise} paise)` : null],
    ["Status", u.status],
    ["Email", u.email],
  ].filter((r): r is [string, string] => Boolean(r[1]));
  return {
    subject: `Razorpay webhook for an unknown ${u.kind}: ${id ?? "(no id)"}`,
    detail: [
      `Razorpay sent ${u.event} for a ${u.kind} this database has no row for. Nothing was changed; the webhook was answered 200.`,
      "",
      ...rows.map(([k, v]) => `  ${k.padEnd(13)} ${v}`),
      "",
      "If it belongs to a client still in another database, import them: npx tsx scripts/prod/import-client.ts --from <db url> --email <email>",
      "Then check the charge in the Razorpay dashboard — a missed renewal isn't replayed automatically.",
    ].join("\n"),
  };
}

/** Logs and alerts once per delivery. Never throws: the webhook must still answer 200. */
export async function reportUnknownWebhook(deps: UnknownWebhookDeps, u: UnknownWebhook): Promise<"reported" | "duplicate" | "failed"> {
  const key = unknownKey(u);
  try {
    if (await deps.alreadyReported(key)) return "duplicate";
    await deps.log(key, u);
    const { subject, detail } = describeUnknown(u);
    await deps.alertAdmin(subject, detail);
    return "reported";
  } catch (err) {
    console.error(`[razorpay-webhook] reporting unknown ${u.kind} failed:`, key, err);
    return "failed";
  }
}
