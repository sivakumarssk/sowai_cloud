/**
 * Recomputes monthlyCost on every registered node from Hetzner's price and HETZNER_USD_TO_INR.
 *
 *   npx tsx scripts/node/recompute-node-costs.ts            # prints old and new, saves nothing
 *   npx tsx scripts/node/recompute-node-costs.ts --apply    # saves them
 *
 * Hetzner is only read. --apply writes the database and nothing else: no server is touched, and
 * nothing to do with billing. It's refused on a default rate.
 */
import { config as loadEnv } from "dotenv";
import { exitUnlessEnvironment } from "../lib/env";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
exitUnlessEnvironment();

const apply = process.argv.slice(2).includes("--apply");
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

(async () => {
  const { hetzner } = await import("../../src/lib/hetzner");
  const { nodeCost } = await import("../../src/lib/nodes/nodeCosts");
  const { inrRate } = await import("../../src/lib/provisioning/capacityReport");
  const { prismaEngineLog } = await import("../../src/engine/data/engineLog");
  const { prisma } = await import("../../src/lib/prisma");
  try {
    const rate = inrRate("USD", process.env);
    if ("problem" in rate) throw new Error(rate.problem);
    console.log(rate.source.replace("Hetzner reports USD, ", "Rate: "));
    if ("warning" in rate) {
      console.log(rate.warning);
      if (apply) throw new Error("Set HETZNER_USD_TO_INR before saving costs");
    }
    const nodes = await prisma.proxmoxNode.findMany({ select: { id: true, name: true, hetznerServerId: true, location: true, monthlyCost: true }, orderBy: { name: "asc" } });
    if (nodes.length === 0) console.log("No nodes are registered.");
    for (const n of nodes) {
      const cost = await nodeCost(n, hetzner, rate.rate);
      if ("skipped" in cost) {
        console.log(`${n.name}: skipped, ${cost.skipped}. Still ${rupees(n.monthlyCost)}`);
        continue;
      }
      console.log(`${n.name} (${cost.serverType}): ${rupees(n.monthlyCost)} → ${rupees(cost.monthlyPaise)}/month`);
      if (!apply || cost.monthlyPaise === n.monthlyCost) continue;
      await prisma.proxmoxNode.update({ where: { id: n.id }, data: { monthlyCost: cost.monthlyPaise } });
      await prismaEngineLog({ action: "NODE_COST_RECOMPUTED", toNode: n.name, trigger: "MANUAL", before: { monthlyCost: n.monthlyCost }, after: { monthlyCost: cost.monthlyPaise, serverType: cost.serverType, usdToInr: rate.rate } });
    }
    console.log(apply ? "Saved." : "Nothing saved. Add --apply to save.");
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
