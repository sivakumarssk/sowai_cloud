// Copying one client from another database (the old dev database) into this one.
//
// Copied as they are, with their ids and every Razorpay id: the User, their
// Orders, Payments and Subscriptions — so the next autopay webhook finds the
// subscription here. Their Services are copied as manual servers on billing
// hold, with no server details: the old rows point at containers, nodes and
// Floating IPs this database doesn't know, so an admin assigns the server
// (Admin → Servers → Assign server, SSH-checked) before it shows as running.
// Plans are matched by slug. Nothing is written to the source, and nothing
// about Razorpay, billing amounts, dates or payment statuses is changed.

export type Row = Record<string, unknown>;

export type ClientBundle = {
  user: Row;
  orders: Row[];
  services: Row[];
  subscriptions: Row[];
  payments: Row[];
};

export type ImportTarget = {
  /** Plan id in this database for each slug. */
  planIdBySlug: Map<string, string>;
  /** What already exists here, to refuse instead of overwriting. */
  existing: {
    userEmail: boolean;
    ids: Set<string>;
    razorpayIds: Set<string>;
  };
};

export type ImportPlan =
  | { ok: true; rows: ClientBundle; notes: string[] }
  | { ok: false; refusals: string[] };

export const IMPORTED_STEP = "Setting up — your server is being prepared";
/** Services in these states are copied as "Setting up" until an admin assigns the server. */
const NEEDS_SERVER = new Set(["PENDING", "PROVISIONING", "INSTALLING", "ACTIVE", "FAILED"]);

const pick = (row: Row, keys: string[]) => Object.fromEntries(keys.filter((k) => row[k] !== undefined && row[k] !== null).map((k) => [k, row[k]]));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** Columns copied unchanged (anything missing in an older source is left to this database's default). */
const COLUMNS = {
  user: ["id", "email", "password", "name", "phone", "company", "isVerified", "createdAt", "updatedAt"],
  order: ["id", "userId", "status", "billingCycle", "addons", "region", "osImage", "stackPreset", "hostname", "amount", "gstAmount", "processingFee", "isIntroPrice", "renewalAmount", "quote", "createdAt", "updatedAt"],
  service: ["id", "userId", "orderId", "hostname", "region", "osImage", "stackPreset", "hasCoolify", "startDate", "nextBillingDate", "suspendedAt", "suspendReason", "createdAt", "updatedAt"],
  subscription: ["id", "userId", "serviceId", "orderId", "razorpaySubscriptionId", "razorpayPlanId", "status", "billingCycle", "amount", "gstAmount", "processingFee", "shortUrl", "currentStart", "currentEnd", "chargeAt", "paidCount", "cancelledAt", "createdAt", "updatedAt"],
  payment: ["id", "userId", "serviceId", "orderId", "subscriptionId", "amount", "processingFee", "currency", "razorpayOrderId", "razorpayPaymentId", "status", "invoiceNumber", "gstAmount", "createdAt", "updatedAt"],
};

/** Every id and Razorpay id the import would create — none may exist here already. */
function collectIds(b: ClientBundle) {
  const ids = [b.user, ...b.orders, ...b.services, ...b.subscriptions, ...b.payments].map((r) => str(r.id)!);
  const razorpayIds = [
    ...b.subscriptions.map((s) => str(s.razorpaySubscriptionId)),
    ...b.payments.flatMap((p) => [str(p.razorpayOrderId), str(p.razorpayPaymentId), str(p.invoiceNumber)]),
  ].filter((x): x is string => Boolean(x));
  return { ids, razorpayIds };
}

/** Checks everything and returns the exact rows that would be written. Changes nothing. */
export function planImport(source: ClientBundle, sourcePlanSlug: Map<string, string | null>, target: ImportTarget): ImportPlan {
  const refusals: string[] = [];
  const email = str(source.user.email);

  if (target.existing.userEmail) refusals.push(`${email} already has an account in this database — nothing is overwritten`);
  const { ids, razorpayIds } = collectIds(source);
  const takenIds = ids.filter((id) => target.existing.ids.has(id));
  const takenRzp = razorpayIds.filter((id) => target.existing.razorpayIds.has(id));
  if (takenIds.length) refusals.push(`these ids already exist here: ${takenIds.join(", ")}`);
  if (takenRzp.length) refusals.push(`these Razorpay ids / invoice numbers already exist here: ${takenRzp.join(", ")}`);

  const mapPlan = (what: string, sourcePlanId: unknown): string | null => {
    const slug = sourcePlanSlug.get(String(sourcePlanId));
    if (!slug) {
      refusals.push(`${what} uses plan ${sourcePlanId}, which has no slug in the source — can't match it`);
      return null;
    }
    const id = target.planIdBySlug.get(slug);
    if (!id) refusals.push(`${what} uses plan ${slug}, which doesn't exist here — run scripts/prod/seed.ts first`);
    return id ?? null;
  };

  const notes: string[] = [];
  const orders = source.orders.map((o) => ({ ...pick(o, COLUMNS.order), planId: mapPlan(`order ${o.id}`, o.planId) }));
  const services = source.services.map((s) => {
    const status = String(s.status);
    const needsServer = NEEDS_SERVER.has(status);
    const dropped = ["serverIp", "ipv6Address", "proxmoxVmId", "nodeId", "hetznerFloatingIpId", "sshUsername", "sshPassword", "panelUrl", "panelPassword"].filter((k) => s[k]);
    notes.push(
      `service ${s.id}: ${status} → ${needsServer ? `INSTALLING ("${IMPORTED_STEP}")` : status}, serverSource MANUAL, billingHold on` +
        (dropped.length ? `; not copied (they point at the old database's servers): ${dropped.join(", ")}` : "")
    );
    return {
      ...pick(s, COLUMNS.service),
      planId: mapPlan(`service ${s.id}`, s.planId),
      status: needsServer ? "INSTALLING" : status,
      provisioningStep: needsServer ? IMPORTED_STEP : str(s.provisioningStep),
      provisioningPct: 0,
      serverSource: "MANUAL",
      billingHold: true,
    };
  });
  if (source.user.role === "ADMIN") notes.push(`${email} is an admin in the source; imported as a client (use make-admin.ts if that's wanted)`);
  if (source.subscriptions.length === 0) notes.push("no autopay subscription in the source");

  if (refusals.length) return { ok: false, refusals };
  return {
    ok: true,
    notes,
    rows: {
      user: { ...pick(source.user, COLUMNS.user), role: "CLIENT" },
      orders,
      services,
      subscriptions: source.subscriptions.map((s) => pick(s, COLUMNS.subscription)),
      payments: source.payments.map((p) => pick(p, COLUMNS.payment)),
    },
  };
}

export type LinkCheck = { razorpaySubscriptionId: string; lines: { ok: boolean; text: string }[] };

/**
 * For each Razorpay subscription id: does it resolve, the way the webhook looks
 * it up, to the user, service, order and payments — all of the same client?
 */
export function checkLinks(b: ClientBundle): LinkCheck[] {
  const byId = <T extends Row>(rows: T[]) => new Map(rows.map((r) => [String(r.id), r]));
  const orders = byId(b.orders);
  const services = byId(b.services);
  const userId = String(b.user.id);

  return b.subscriptions.map((sub) => {
    const lines: { ok: boolean; text: string }[] = [];
    const line = (ok: boolean, text: string) => lines.push({ ok, text });
    line(sub.userId === userId, `user      ${sub.userId} ${sub.userId === userId ? `(${b.user.email})` : "— NOT this client"}`);

    const service = sub.serviceId ? services.get(String(sub.serviceId)) : undefined;
    const paid = b.payments.some((p) => p.subscriptionId === sub.id && p.status === "SUCCESS");
    if (!sub.serviceId) line(!paid, paid ? "service   none linked — a renewal would have no server to extend" : "service   none (checkout never paid)");
    else line(Boolean(service && service.userId === userId), `service   ${sub.serviceId} ${service ? `${service.status} · ${service.serverSource} · billingHold ${service.billingHold ? "on" : "off"}` : "— MISSING"}`);

    const order = sub.orderId ? orders.get(String(sub.orderId)) : undefined;
    if (sub.orderId) line(Boolean(order && order.userId === userId), `order     ${sub.orderId} ${order ? String(order.status) : "— MISSING"}`);
    if (service?.orderId) line(!sub.orderId || service.orderId === sub.orderId, `service → order ${service.orderId}${sub.orderId && service.orderId !== sub.orderId ? ` ≠ subscription's ${sub.orderId}` : ""}`);

    const payments = b.payments.filter((p) => p.subscriptionId === sub.id);
    line(payments.length > 0, `payments  ${payments.length}${payments.length ? `: ${payments.map((p) => `${p.razorpayPaymentId ?? p.razorpayOrderId ?? p.id} ${p.status}`).join(", ")}` : " — none linked"}`);
    for (const p of payments) {
      const bad = [p.userId !== userId && "another user", sub.serviceId && p.serviceId && p.serviceId !== sub.serviceId && `service ${p.serviceId}`, p.orderId && !orders.has(String(p.orderId)) && `missing order ${p.orderId}`].filter(Boolean);
      if (bad.length) line(false, `payment   ${p.id} points at ${bad.join(", ")}`);
    }
    return { razorpaySubscriptionId: String(sub.razorpaySubscriptionId), lines };
  });
}
