/**
 * Read-only: what each node has committed, where each VPS plan would be placed right now, how
 * many of each plan fit, and what each plan makes or loses per customer.
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

/** Server plus Primary IPv4, as a node is billed, and the Floating IP, in rupees. Prices only: never stops the report. */
async function hetznerPrices(types: readonly string[]) {
  const servers = new Map<string, number>();
  try {
    const { hetzner, serverTypeOffer } = await import("../../src/lib/hetzner");
    const { serverCost } = await import("../../src/lib/nodes/installNode");
    const { inrRate } = await import("../../src/lib/provisioning/capacityReport");
    const ips = await hetzner.ipPrices(LOCATION);
    const inr = inrRate(ips.currency, process.env);
    if ("problem" in inr) return { servers, floatingIpPaise: null, note: `No server prices: ${inr.problem}` };
    const unavailable: string[] = [];
    for (const name of types) {
      const type = await hetzner.getServerType(name);
      const offer = type && serverTypeOffer(type, LOCATION);
      if (!offer?.price) {
        unavailable.push(`${name} has no price`);
        continue;
      }
      if (!offer.buyable) unavailable.push(offer.reason ?? `${name} can't be bought`);
      const cost = serverCost(name, offer.price, ips, { location: LOCATION, eurToInr: inr.rate }, false);
      if ("monthlyPaise" in cost) servers.set(name, cost.monthlyPaise);
    }
    const floatingIpPaise = ips.floatingIpv4MonthlyEur === null ? null : Math.ceil(ips.floatingIpv4MonthlyEur * inr.rate * 100);
    return { servers, floatingIpPaise, note: `${LOCATION} prices. ${inr.source}, VAT ${ips.vatRate}%${unavailable.length ? `. ${unavailable.join("; ")}` : ""}` };
  } catch (err) {
    return { servers, floatingIpPaise: null, note: `Hetzner prices not available: ${err instanceof Error ? err.message : err}` };
  }
}

(async () => {
  const { nodeLoads, placementConfig, planNeed } = await import("../../src/lib/provisioning/placementDeps");
  const { chooseNode, nodeFit } = await import("../../src/lib/provisioning/placement");
  const { DOCUMENTED_SIZES, ILLUSTRATIVE_OVERCOMMIT, emptied, fitLines, hostLine, hypotheticalNode, includedIps, planEconomicsLines } = await import("../../src/lib/provisioning/capacityReport");
  const { planFeatures } = await import("../../src/lib/plans");
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
    const plans = await prisma.plan.findMany({ where: { category: "VPS", isActive: true }, select: { name: true, isDedicated: true, features: true, ramGB: true, storageGB: true, priceIntro1Year: true, priceIntro2Year: true, priceMonthly: true, priceRenewal: true }, orderBy: [{ ramGB: "asc" }, { name: "asc" }] });
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

    const hz = await hetznerPrices(DOCUMENTED_SIZES.map((s) => s.type));
    const costs = await prisma.proxmoxNode.findMany({ select: { id: true, monthlyCost: true } });
    const overcommit = config.ramOvercommit > 1 ? config.ramOvercommit : ILLUSTRATIVE_OVERCOMMIT;
    const servers = [
      ...DOCUMENTED_SIZES.flatMap((size) => {
        const cost = hz.servers.get(size.type);
        return cost ? [{ name: size.type, node: hypotheticalNode(size), monthlyCostPaise: cost, estimate: true }] : [];
      }),
      ...nodes.map((n) => ({ name: n.name, node: emptied(n), monthlyCostPaise: costs.find((c) => c.id === n.id)!.monthlyCost, estimate: false })),
    ];
    console.log(`\nUnit economics: full nodes, profit after Floating IPs, before tax, payment fees, traffic, backups and support`);
    console.log(`${hz.note}. "est." = Hetzner's documented size, and a real node measures less. RAM ×${overcommit} is ${config.ramOvercommit > 1 ? "NODE_RAM_OVERCOMMIT" : "illustrative"}. Break-even is per price, in the order shown.\n`);
    for (const p of plans) {
      const plan = {
        ...rows.find((r) => r.name === p.name)!,
        isDedicated: p.isDedicated,
        prices: { intro1Year: p.priceIntro1Year, intro2Year: p.priceIntro2Year, monthly: p.priceMonthly, renewal: p.priceRenewal },
        ips: includedIps(planFeatures(p)),
      };
      for (const line of planEconomicsLines(plan, servers, { config, overcommit, floatingIpPaise: hz.floatingIpPaise })) console.log(line);
      console.log();
    }
    const skipped = await prisma.plan.count({ where: { category: { not: "VPS" }, isActive: true } });
    if (skipped) console.log(`${skipped} active non-VPS plans aren't here: they don't run as containers on these nodes.`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
