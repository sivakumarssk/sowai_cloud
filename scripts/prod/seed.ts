/**
 * Production seed: creates the plans and the ProxmoxNode from .env. Nothing else —
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
  const { ADDONS, PLANS, upsertNode, upsertPlans } = await import("../../prisma/catalog");
  try {
    const ids = await upsertPlans(prisma, { textOnly: true });
    console.log(`Plans: ${ids.length} upserted (${PLANS.map((p) => p.slug).join(", ")})`);

    const undelivered = ADDONS.filter((a) => a.isActive === false).map((a) => a.slug);
    const hidden = await prisma.addon.updateMany({ where: { slug: { in: undelivered }, isActive: true }, data: { isActive: false } });
    console.log(`Addons: ${hidden.count} switched off (${undelivered.join(", ")} aren't delivered)`);

    const node = await upsertNode(prisma);
    if (node) console.log(`Node: ${node.name} (${node.ip}, Hetzner server ${node.hetznerServerId}, ${node.location}) upserted`);
    else console.log("Node: skipped — set PROXMOX_NODE, PROXMOX_HOST and HETZNER_SERVER_ID in .env, then run this again");

    const users = await prisma.user.count();
    console.log(`Users in this database: ${users} (the seed never creates any)`);
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
