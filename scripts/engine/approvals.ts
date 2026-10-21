/**
 * Step 8: engine approval requests (ASSISTED actions, purchases, spend over the cap).
 *
 *   npx tsx scripts/engine/approvals.ts                          # open requests + the last 20 decided
 *   npx tsx scripts/engine/approvals.ts approve <id> --by NAME   # approve (runs within a minute if the engine is running)
 *   npx tsx scripts/engine/approvals.ts approve <id> --by NAME --run-now   # approve and run it here, now
 *   npx tsx scripts/engine/approvals.ts deny <id> --by NAME
 *   npx tsx scripts/engine/approvals.ts run                      # expire overdue requests, run approved ones
 *
 * Requests expire 2 hours after they're made; an expired request can't be approved.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });

const argv = process.argv.slice(2);
const [command, id] = argv;
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

(async () => {
  const { prisma } = await import("../../src/lib/prisma");
  const runApprovals = async () => {
    const { loadEngineConfig } = await import("../../src/engine/config");
    const { buildDecisionEngine } = await import("../../src/engine/data/decisionDeps");
    const r = await buildDecisionEngine(loadEngineConfig()).executor.processApprovals();
    console.log(`expired ${r.expired} · executed ${r.executed} · failed ${r.failed}`);
  };

  try {
    if (!command || command === "list") {
      const open = await prisma.engineApproval.findMany({ where: { status: { in: ["PENDING", "APPROVED"] }, executedAt: null }, orderBy: { createdAt: "asc" } });
      const done = await prisma.engineApproval.findMany({ where: { NOT: { id: { in: open.map((o) => o.id) } } }, orderBy: { updatedAt: "desc" }, take: 20 });
      console.log(open.length ? "Open:" : "No open requests.");
      for (const a of open) {
        const mins = Math.round((a.expiresAt.getTime() - Date.now()) / 60_000);
        console.log(
          `  ${a.id}  ${a.status.padEnd(8)} ${a.kind.padEnd(15)} ${a.summary}${a.monthlyCostPaise ? `  +${rupees(a.monthlyCostPaise)}/mo` : ""}  ${a.status === "PENDING" ? (mins > 0 ? `expires in ${mins} min` : "overdue") : `approved by ${a.decidedBy}`}`
        );
        console.log(`      why: ${a.reason}`);
      }
      if (done.length) console.log("\nRecent:");
      for (const a of done) {
        console.log(`  ${a.id}  ${a.status.padEnd(8)} ${a.kind.padEnd(15)} ${a.summary}${a.decidedBy ? `  (${a.decidedBy})` : ""}${a.result ? `  → ${a.result}` : ""}`);
      }
      return;
    }

    if (command === "run") return await runApprovals();

    if (command !== "approve" && command !== "deny") throw new Error(`unknown command "${command}" — list | approve <id> | deny <id> | run`);
    const by = value("--by")?.trim();
    if (!id || id.startsWith("--")) throw new Error(`usage: approvals.ts ${command} <id> --by <your name>`);
    if (!by) throw new Error("--by <your name> is required (it goes in the audit log)");

    const { count } = await prisma.engineApproval.updateMany({
      where: { id, status: "PENDING", expiresAt: { gt: new Date() } },
      data: { status: command === "approve" ? "APPROVED" : "DENIED", decidedBy: by, decidedAt: new Date() },
    });
    if (count === 0) {
      const a = await prisma.engineApproval.findUnique({ where: { id } });
      throw new Error(!a ? `no request ${id}` : a.status === "PENDING" ? `${id} expired at ${a.expiresAt.toISOString()}` : `${id} is already ${a.status}`);
    }
    const a = await prisma.engineApproval.findUniqueOrThrow({ where: { id } });
    await prisma.engineLog.create({
      data: { action: command === "approve" ? "APPROVAL_GRANTED" : "APPROVAL_DENIED", after: { approvalId: id, kind: a.kind, summary: a.summary, by }, trigger: "MANUAL", dryRun: true },
    });
    console.log(`✓ ${command === "approve" ? "approved" : "denied"}: ${a.summary}`);

    if (command === "approve") {
      if (argv.includes("--run-now")) await runApprovals();
      else console.log("The running engine carries it out within a minute (or add --run-now).");
    }
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
