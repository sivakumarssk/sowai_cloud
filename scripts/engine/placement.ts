/**
 * Read-only: what each node has committed, where each VPS plan would be placed right now, how
 * many of each plan fit, and what a VPS Basic costs to run.
 *
 *   npx tsx scripts/engine/placement.ts
 *
 * Changes nothing; Hetzner is only asked for prices. Run
 * `npx tsx scripts/engine/watchServers.ts --live --once` first so the nodes' measured
 * RAM/disk, host usage and current allocations are fresh.
 */
import { config as loadEnv } from "dotenv";
import { exitUnlessEnvironment } from "../lib/env";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
exitUnlessEnvironment();

const LOCATION = "nbg1";

/** Server plus Primary IPv4, as a node is billed, and the Floating IP. Prices only: never stops the report. */
async function hetznerPrices(types: readonly string[]) {
  const servers = new Map<string, { monthlyPaise: number; note: string }>();
  try {
    const { hetzner, serverTypeOffer } = await import("../../src/lib/hetzner");
    const { serverCost } = await import("../../src/lib/nodes/installNode");
    const eurToInr = Number(process.env.HETZNER_EUR_TO_INR || 100);
    const ips = await hetzner.ipPrices(LOCATION);
    for (const name of types) {
      const type = await hetzner.getServerType(name);
      const offer = type && serverTypeOffer(type, LOCATION);
      if (!offer?.price) continue;
      const cost = serverCost(name, offer.price, ips, { location: LOCATION, eurToInr }, false);
      if ("monthlyPaise" in cost) servers.set(name, { monthlyPaise: cost.monthlyPaise, note: offer.buyable ? "" : `; can't be bought now: ${offer.reason}` });
    }
    const floatingIpPaise = ips.floatingIpv4MonthlyEur === null ? null : Math.ceil(ips.floatingIpv4MonthlyEur * eurToInr * 100);
    return { servers, floatingIpPaise, problem: `${LOCATION} prices at ₹${eurToInr}/€` };
  } catch (err) {
    return { servers, floatingIpPaise: null, problem: `Hetzner prices not available: ${err instanceof Error ? err.message : err}` };
  }
}

(async () => {
  const { nodeLoads, placementConfig, planNeed } = await import("../../src/lib/provisioning/placementDeps");
  const { chooseNode, fitCount, nodeFit } = await import("../../src/lib/provisioning/placement");
  const { DOCUMENTED_SIZES, emptied, fitLines, hostLine, hypotheticalNode, unitEconomicsLines } = await import("../../src/lib/provisioning/capacityReport");
  const { prisma } = await import("../../src/lib/prisma");
  try {
    const config = placementConfig();
    const nodes = await nodeLoads(prisma);
    console.log(`Placement · RAM overcommit ×${config.ramOvercommit} · disk reserve ${config.diskPoolReserveGB} GB · host RAM reserve ${config.hostRamReserveMB} MB when not measured\n`);
    for (const n of nodes) {
      const free = nodeFit(n, { ramMB: 0, diskGB: 0 }, config);
      console.log(
        `${n.name} (${n.location}, server ${n.hetznerServerId}, ${n.ip}, IPv6 ${n.ipv6Subnet ?? "NOT SET"}) · ${n.status} · ${n.acceptNewClients ? "open" : "CLOSED"}`
      );
      console.log(`  capacity ${n.physicalRamMB} MB RAM, ${n.physicalDiskGB} GB pool, max ${n.maxContainers} containers`);
      console.log(`  ${hostLine(n, config)}`);
      console.log(`  monitor  ${n.monitor ? `${n.monitor.allocatedRamMB} MB, ${n.monitor.allocatedDiskGB} GB, ${n.monitor.containerCount} containers` : "stale or never seen — database figures only"}`);
      console.log(`  services ${n.settled.ramMB} MB, ${n.settled.diskGB} GB, ${n.settled.count} live · in flight ${n.inFlight.ramMB} MB, ${n.inFlight.diskGB} GB, ${n.inFlight.count}`);
      console.log(`  free     ${free.ok ? `${free.freeRamMB} MB RAM, ${free.freeDiskGB} GB disk` : free.reason}\n`);
    }
    const plans = await prisma.plan.findMany({ where: { category: "VPS", isActive: true }, select: { slug: true, name: true, ramGB: true, storageGB: true, priceIntro1Year: true, priceIntro2Year: true, priceMonthly: true, priceRenewal: true }, orderBy: [{ ramGB: "asc" }, { name: "asc" }] });
    for (const p of plans) {
      const c = chooseNode(nodes, planNeed(p), config);
      console.log(`${p.name.padEnd(20)} ${p.ramGB} GB / ${p.storageGB} GB → ${c.node ? c.node.name : `WAITS — ${c.reasons.join("; ")}`}`);
    }

    const rows = plans.map((p) => ({ name: p.name, need: planNeed(p) }));
    console.log("\nContainers that fit now, host reserve applied");
    for (const n of nodes) {
      console.log(`${n.name} · measured ${n.physicalRamMB} MB, ${n.physicalDiskGB} GB · ${hostLine(n, config)}`);
      for (const line of fitLines(n, rows, config)) console.log(line);
    }
    console.log("\nA new, empty server. ESTIMATES: Hetzner's documented sizes, and a real node measures less");
    for (const size of DOCUMENTED_SIZES) {
      const n = hypotheticalNode(size);
      console.log(`${size.type} · ESTIMATE ${size.ramGB} GB, ${size.diskGB} GB · ${hostLine(n, config)}`);
      for (const line of fitLines(n, rows, config)) console.log(line);
    }

    const basic = plans.find((p) => p.slug === "VPS_BASIC");
    if (!basic) {
      console.log("\
No active VPS Basic plan, so no unit economics.");
      return;
    }
    const need = planNeed(basic);
    const prices = { intro1Year: basic.priceIntro1Year, intro2Year: basic.priceIntro2Year, monthly: basic.priceMonthly, renewal: basic.priceRenewal };
    const hz = await hetznerPrices(DOCUMENTED_SIZES.map((s) => s.type));
    console.log(`
VPS Basic unit economics: a full node, before tax and payment fees${hz.problem ? ` (${hz.problem})` : ""}`);
    const costs = await prisma.proxmoxNode.findMany({ select: { id: true, monthlyCost: true } });
    for (const n of nodes) {
      console.log(`${n.name} · measured`);
      for (const line of unitEconomicsLines({ monthlyCostPaise: costs.find((c) => c.id === n.id)!.monthlyCost, basicFit: fitCount(emptied(n), need, config), prices, floatingIpPaise: hz.floatingIpPaise })) console.log(line);
    }
    for (const size of DOCUMENTED_SIZES) {
      const cost = hz.servers.get(size.type);
      console.log(`${size.type} · ESTIMATED fit, ${cost ? `Hetzner's price${cost.note}` : "no price"}`);
      if (cost) for (const line of unitEconomicsLines({ monthlyCostPaise: cost.monthlyPaise, basicFit: fitCount(hypotheticalNode(size), need, config), prices, floatingIpPaise: hz.floatingIpPaise })) console.log(line);
    }
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
