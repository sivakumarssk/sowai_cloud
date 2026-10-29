/**
 * Read-only: what each node has committed, and where each VPS plan would be placed right now.
 *
 *   npx tsx scripts/engine/placement.ts
 *
 * Changes nothing. Run `npx tsx scripts/engine/watchServers.ts --live --once` first
 * so the nodes' measured RAM/disk and current allocations are fresh.
 */
import { config as loadEnv } from "dotenv";
import { exitUnlessEnvironment } from "../lib/env";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
exitUnlessEnvironment();

(async () => {
  const { nodeLoads, placementConfig, planNeed } = await import("../../src/lib/provisioning/placementDeps");
  const { chooseNode, nodeFit } = await import("../../src/lib/provisioning/placement");
  const { prisma } = await import("../../src/lib/prisma");
  try {
    const config = placementConfig();
    const nodes = await nodeLoads(prisma);
    console.log(`Placement · RAM overcommit ×${config.ramOvercommit} · disk reserve ${config.diskPoolReserveGB} GB\n`);
    for (const n of nodes) {
      const free = nodeFit(n, { ramMB: 0, diskGB: 0 }, config);
      console.log(
        `${n.name} (${n.location}, server ${n.hetznerServerId}, ${n.ip}, IPv6 ${n.ipv6Subnet ?? "NOT SET"}) · ${n.status} · ${n.acceptNewClients ? "open" : "CLOSED"}`
      );
      console.log(`  capacity ${n.physicalRamMB} MB RAM, ${n.physicalDiskGB} GB pool, max ${n.maxContainers} containers`);
      console.log(`  monitor  ${n.monitor ? `${n.monitor.allocatedRamMB} MB, ${n.monitor.allocatedDiskGB} GB, ${n.monitor.containerCount} containers` : "stale or never seen — database figures only"}`);
      console.log(`  services ${n.settled.ramMB} MB, ${n.settled.diskGB} GB, ${n.settled.count} live · in flight ${n.inFlight.ramMB} MB, ${n.inFlight.diskGB} GB, ${n.inFlight.count}`);
      console.log(`  free     ${free.ok ? `${free.freeRamMB} MB RAM, ${free.freeDiskGB} GB disk` : free.reason}\n`);
    }
    const plans = await prisma.plan.findMany({ where: { category: "VPS", isActive: true }, select: { name: true, ramGB: true, storageGB: true }, orderBy: [{ ramGB: "asc" }, { name: "asc" }] });
    for (const p of plans) {
      const c = chooseNode(nodes, planNeed(p), config);
      console.log(`${p.name.padEnd(20)} ${p.ramGB} GB / ${p.storageGB} GB → ${c.node ? c.node.name : `WAITS — ${c.reasons.join("; ")}`}`);
    }
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
