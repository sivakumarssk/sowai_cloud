/**
 * Copies one client from another database (e.g. the old dev database) into this one (DATABASE_URL).
 *
 *   npx tsx scripts/prod/import-client.ts --from "<source db url>" --email client@example.com             # plan — changes nothing
 *   npx tsx scripts/prod/import-client.ts --from "<source db url>" --email client@example.com --execute   # copy
 *
 * Copies their User, Orders, Payments, Subscriptions and Services with the same ids and every
 * Razorpay id, so autopay webhooks find them here. Plans are matched by slug. Services arrive as
 * manual servers on billing hold, "Setting up" until an admin assigns the server (Admin → Servers).
 * The source is opened read-only. Nothing is sent to Razorpay; no payment, amount, date or status
 * of a payment or subscription is changed. Refuses if anything already exists here.
 * Logged to EngineLog (CLIENT_IMPORTED).
 */
import { config as loadEnv } from "dotenv";
import { exitUnlessEnvironment } from "../lib/env";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
exitUnlessEnvironment();

const argv = process.argv.slice(2);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** host:port/database — never the password. */
function describeDb(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return "(unparseable url)";
  }
}

(async () => {
  const { Pool } = await import("pg");
  const { prisma } = await import("../../src/lib/prisma");
  const { planImport, checkLinks } = await import("../../src/lib/billing/importClient");
  const { prismaEngineLog } = await import("../../src/engine/data/engineLog");
  type ClientBundle = import("../../src/lib/billing/importClient").ClientBundle;
  type Row = import("../../src/lib/billing/importClient").Row;

  const from = value("--from");
  const email = value("--email")?.trim().toLowerCase();
  const execute = argv.includes("--execute");
  // Read-only at the server: any write to the source fails.
  const source = from ? new Pool({ connectionString: from, options: "-c default_transaction_read_only=on", max: 2 }) : null;

  try {
    if (!from || !email || from.startsWith("--") || email.startsWith("--")) throw new Error('usage: import-client.ts --from "<source db url>" --email <email> [--execute]');
    if (describeDb(from) === describeDb(process.env.DATABASE_URL ?? "")) throw new Error(`--from is this database (${describeDb(from)}) — it must be the other one`);
    console.log(`Source (read-only): ${describeDb(from)}\nTarget (DATABASE_URL): ${describeDb(process.env.DATABASE_URL ?? "")}\n`);

    // ── Read the client from the source ──
    const q = async (sql: string, params: unknown[]) => (await source!.query(sql, params)).rows as Row[];
    const [user] = await q(`SELECT * FROM "User" WHERE lower(email) = $1`, [email]);
    if (!user) throw new Error(`no user ${email} in the source database`);
    const bundle: ClientBundle = {
      user,
      orders: await q(`SELECT * FROM "Order" WHERE "userId" = $1 ORDER BY "createdAt"`, [user.id]),
      services: await q(`SELECT * FROM "Service" WHERE "userId" = $1 ORDER BY "createdAt"`, [user.id]),
      subscriptions: await q(`SELECT * FROM "Subscription" WHERE "userId" = $1 ORDER BY "createdAt"`, [user.id]),
      payments: await q(`SELECT * FROM "Payment" WHERE "userId" = $1 ORDER BY "createdAt"`, [user.id]),
    };
    const planIds = [...new Set([...bundle.orders, ...bundle.services].map((r) => String(r.planId)))];
    const sourcePlans = planIds.length ? await q(`SELECT id, slug FROM "Plan" WHERE id = ANY($1)`, [planIds]) : [];
    const sourcePlanSlug = new Map(sourcePlans.map((p) => [String(p.id), p.slug ? String(p.slug) : null]));

    // ── What already exists here ──
    const all = [bundle.user, ...bundle.orders, ...bundle.services, ...bundle.subscriptions, ...bundle.payments].map((r) => String(r.id));
    const rzpSubs = bundle.subscriptions.map((s) => String(s.razorpaySubscriptionId));
    const rzpPay = bundle.payments.flatMap((p) => [p.razorpayOrderId, p.razorpayPaymentId, p.invoiceNumber]).filter(Boolean).map(String);
    const [targetPlans, existingUser, ...found] = await Promise.all([
      prisma.plan.findMany({ where: { slug: { not: null } }, select: { id: true, slug: true } }),
      prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } }),
      prisma.user.findMany({ where: { id: { in: all } }, select: { id: true } }),
      prisma.order.findMany({ where: { id: { in: all } }, select: { id: true } }),
      prisma.service.findMany({ where: { id: { in: all } }, select: { id: true } }),
      prisma.subscription.findMany({ where: { OR: [{ id: { in: all } }, { razorpaySubscriptionId: { in: rzpSubs } }] }, select: { id: true, razorpaySubscriptionId: true } }),
      prisma.payment.findMany({
        where: { OR: [{ id: { in: all } }, { razorpayOrderId: { in: rzpPay } }, { razorpayPaymentId: { in: rzpPay } }, { invoiceNumber: { in: rzpPay } }] },
        select: { id: true, razorpayOrderId: true, razorpayPaymentId: true, invoiceNumber: true },
      }),
    ]);
    const existingIds = new Set(found.flat().map((r) => r.id));
    const existingRzp = new Set(
      found.flat().flatMap((r) => Object.entries(r).filter(([k, v]) => k !== "id" && v).map(([, v]) => String(v))).filter((v) => rzpSubs.includes(v) || rzpPay.includes(v))
    );

    const plan = planImport(bundle, sourcePlanSlug, {
      planIdBySlug: new Map(targetPlans.map((p) => [p.slug!, p.id])),
      existing: { userEmail: Boolean(existingUser), ids: existingIds, razorpayIds: existingRzp },
    });

    console.log(`Client: ${user.name} <${user.email}> (${user.id})`);
    console.log(`  orders ${bundle.orders.length} · services ${bundle.services.length} · subscriptions ${bundle.subscriptions.length} · payments ${bundle.payments.length}`);
    if (!plan.ok) {
      console.log("\n✗ Won't import:");
      for (const r of plan.refusals) console.log(`  - ${r}`);
      await prismaEngineLog({ action: "CLIENT_IMPORT_REFUSED", after: { email, from: describeDb(from), refusals: plan.refusals }, trigger: "MANUAL", dryRun: true, success: false, error: plan.refusals.join("; ") });
      process.exitCode = 1;
      return;
    }
    for (const n of plan.notes) console.log(`  · ${n}`);
    for (const p of bundle.payments) console.log(`  payment ${p.id}  ${p.status}  ₹${Number(p.amount) / 100}  order ${p.razorpayOrderId ?? "—"}  payment ${p.razorpayPaymentId ?? "—"}  invoice ${p.invoiceNumber ?? "—"}`);
    for (const s of bundle.subscriptions) console.log(`  subscription ${s.razorpaySubscriptionId}  ${s.status}  paid ${s.paidCount}×  next charge ${s.chargeAt ? new Date(String(s.chargeAt)).toISOString() : "—"}`);

    const printChecks = (title: string, b: ClientBundle) => {
      console.log(`\n${title}`);
      const checks = checkLinks(b);
      if (checks.length === 0) console.log("  (no subscription to check)");
      for (const c of checks) {
        console.log(`  ${c.razorpaySubscriptionId}`);
        for (const l of c.lines) console.log(`    ${l.ok ? "✓" : "✗"} ${l.text}`);
      }
      return checks.every((c) => c.lines.every((l) => l.ok));
    };

    if (!execute) {
      const ok = printChecks("Check (on the rows that would be written):", plan.rows);
      await prismaEngineLog({ action: "CLIENT_IMPORT_PLANNED", after: { email, from: describeDb(from), notes: plan.notes, linksOk: ok }, trigger: "MANUAL", dryRun: true });
      console.log(`\nPlan only — nothing changed. Add --execute to copy.${ok ? "" : " Fix the ✗ lines first (or confirm they are expected)."}`);
      return;
    }

    // ── Copy, all or nothing ──
    const r = plan.rows;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    await prisma.$transaction(async (tx) => {
      await tx.user.create({ data: r.user as any });
      if (r.orders.length) await tx.order.createMany({ data: r.orders as any });
      if (r.services.length) await tx.service.createMany({ data: r.services as any });
      if (r.subscriptions.length) await tx.subscription.createMany({ data: r.subscriptions as any });
      if (r.payments.length) await tx.payment.createMany({ data: r.payments as any });
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // ── Re-read exactly the way the webhook does: by Razorpay subscription id ──
    const copied: ClientBundle = {
      user: (await prisma.user.findUniqueOrThrow({ where: { id: String(user.id) } })) as Row,
      orders: (await prisma.order.findMany({ where: { userId: String(user.id) } })) as Row[],
      services: (await prisma.service.findMany({ where: { userId: String(user.id) } })) as Row[],
      subscriptions: (await prisma.subscription.findMany({ where: { razorpaySubscriptionId: { in: rzpSubs } } })) as Row[],
      payments: (await prisma.payment.findMany({ where: { userId: String(user.id) } })) as Row[],
    };
    const ok = printChecks("Check (read back from this database by Razorpay subscription id):", copied);
    await prismaEngineLog({
      action: "CLIENT_IMPORTED",
      after: { email, userId: user.id, from: describeDb(from), orders: r.orders.length, services: r.services.map((s) => s.id), subscriptions: rzpSubs, payments: r.payments.length, notes: plan.notes, linksOk: ok },
      trigger: "MANUAL",
      success: ok,
    });
    console.log(`\n✓ Imported ${user.email}.${ok ? "" : " Some links are ✗ — see above."}`);
    console.log("Next: Admin → Servers → Assign server for each service. Billing hold stays on until you release it there.");
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await source?.end();
    await prisma.$disconnect();
  }
})();
