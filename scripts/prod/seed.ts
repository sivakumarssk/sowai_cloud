/**
 * Production seed: creates the plans. Nothing else — no node (nodes are registered by
 * scripts/node/install-node.ts, each with its own API token),
 * no users (create your account on the site, then scripts/prod/make-admin.ts), no
 * addons, no orders. Safe to run again: on a plan that exists it only updates the
 * name and features, never a price, and it switches off any addon nothing delivers.
 *
 *   npx tsx scripts/prod/seed.ts
 */
import { config as loadEnv } from "dotenv";
import { exitUnlessEnvironment } from "../lib/env";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
exitUnlessEnvironment();

(async () => {
  const { prisma } = await import("../../src/lib/prisma");
  const { ADDONS, PLANS, upsertPlans } = await import("../../prisma/catalog");
  try {
    const ids = await upsertPlans(prisma, { textOnly: true });
    console.log(`Plans: ${ids.length} upserted (${PLANS.map((p) => p.slug).join(", ")})`);

    const undelivered = ADDONS.filter((a) => a.isActive === false).map((a) => a.slug);
    const hidden = await prisma.addon.updateMany({ where: { slug: { in: undelivered }, isActive: true }, data: { isActive: false } });
    console.log(`Addons: ${hidden.count} switched off (${undelivered.join(", ")} aren't delivered)`);

    console.log("Nodes: none from the seed. Register one with scripts/node/install-node.ts");

    const users = await prisma.user.count();
    console.log(`Users in this database: ${users} (the seed never creates any)`);
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
