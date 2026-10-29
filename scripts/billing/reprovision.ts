/**
 * Rebuild a paid service that has no real server (e.g. "fulfilled" by the simulator).
 *
 *   npx tsx scripts/billing/reprovision.ts --service <id>                         # plan: what it resets and builds — changes nothing
 *   npx tsx scripts/billing/reprovision.ts --service <id> --execute --by <name>   # reset + real provisionVPS (node placement)
 *
 * Refuses if a container or Floating IP already exists for the service, if
 * its Razorpay subscription isn't active, if it was refunded, or if no node
 * can hold the plan. Never touches the Payment rows, the Subscription rows or
 * refunds; a failed rebuild releases what it bought and does NOT refund.
 * Every run is logged to EngineLog (REPROVISION_*).
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });

const argv = process.argv.slice(2);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

(async () => {
  const { planReprovision, executeReprovision } = await import("../../src/lib/billing/reprovision");
  const { prismaReprovisionDeps } = await import("../../src/lib/billing/reprovisionDeps");
  const { prisma } = await import("../../src/lib/prisma");
  const serviceId = value("--service");
  const execute = argv.includes("--execute");
  const by = value("--by")?.trim() || "admin";

  try {
    if (!serviceId || serviceId.startsWith("--")) throw new Error("usage: reprovision.ts --service <id> [--execute --by <name>]");
    const deps = prismaReprovisionDeps();

    const planned = await planReprovision(serviceId, deps);
    if (!planned.ok) {
      console.log(`✗ Won't rebuild ${serviceId}:`);
      for (const r of planned.refusals) console.log(`  - ${r}`);
      await deps.log({ action: "REPROVISION_REFUSED", serviceId, after: { refusals: planned.refusals, by, execute }, dryRun: true, success: false, error: planned.refusals.join("; ") });
      process.exitCode = 1;
      return;
    }

    const { snapshot: s, changes, build } = planned.plan;
    console.log(`Service ${s.id} · ${s.plan.name} · ${s.customer} · status ${s.status}`);
    console.log(`Autopay ${s.subscription?.razorpaySubscriptionId} is active at Razorpay · payments: ${s.paymentStatuses.join(", ")}\n`);
    console.log("Will reset (Service row only):");
    for (const c of changes) console.log(`  ${c.field.padEnd(20)} ${c.from} → ${c.to}`);
    console.log(`\nWill build: ${build}`);
    console.log("Will NOT touch: Payment rows, Subscription rows, Razorpay, refunds, next billing date.\n");

    if (!execute) {
      await deps.log({ action: "REPROVISION_PLANNED", serviceId, after: { changes, build, by }, dryRun: true });
      console.log("Plan only — nothing changed. Add --execute --by <your name> to rebuild.");
      return;
    }

    console.log("Rebuilding (a few minutes)…");
    const result = await executeReprovision(serviceId, deps, by);
    if (!result.ok) {
      console.log(`✗ Stopped: ${result.refusals.join("; ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${result.status === "ACTIVE" ? "✓" : "✗"} ${result.detail}`);
    if (result.status !== "ACTIVE") process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
