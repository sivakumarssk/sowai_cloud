/**
 * Sends every gateway its whole route table (Stage C of the shared IPv4 gateway). Provisioning
 * syncs on each route change; this catches a missed one, so run it every 5 minutes.
 *
 *   npx tsx scripts/node/gateway-sync.ts                      # every node with a gateway
 *   npx tsx scripts/node/gateway-sync.ts --node sowsi-test-07
 *   npx tsx scripts/node/gateway-sync.ts --cron               # also alerts on a failure, at most once an hour per node
 *
 * Cron on sowsi-mgmt-01:
 *   *\/5 * * * * cd /var/www/sowsicloud-prod && npx tsx scripts/node/gateway-sync.ts --cron >> /var/log/sowsi-gateway-sync.log 2>&1
 *
 * Changes nothing but the gateways' tables (and the versions recorded for them). A retired node is
 * skipped. Exits 1 if any sync failed.
 */
import { config as loadEnv } from "dotenv";
import { exitUnlessEnvironment } from "../lib/env";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
exitUnlessEnvironment();

const argv = process.argv.slice(2);
const value = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const ALERT_EVERY_MS = 60 * 60_000;

(async () => {
  const unknown = argv.filter((a, i) => a.startsWith("--") && !["--node", "--cron"].includes(a) && argv[i - 1] !== "--node");
  if (unknown.length) throw new Error(`unknown option ${unknown.join(" ")}; usage: gateway-sync.ts [--node <name>] [--cron]`);
  const only = value("--node");
  if (argv.includes("--node") && !only) throw new Error("--node needs a node name");
  const cron = argv.includes("--cron");

  const { prisma } = await import("../../src/lib/prisma");
  const { prismaGatewaySyncDeps } = await import("../../src/lib/nodes/gatewaySyncDeps");
  const { describeSync, syncGateway } = await import("../../src/lib/nodes/gatewaySync");
  const { isRetired } = await import("../../src/lib/provisioning/nodeTarget");
  const { alertAdmins } = await import("../../src/lib/adminAlert");
  const { prismaEngineLog } = await import("../../src/engine/data/engineLog");

  try {
    const nodes = await prisma.proxmoxNode.findMany({
      where: { gatewayIpv4: { not: null }, ...(only && { name: only }) },
      select: { id: true, name: true, status: true },
      orderBy: { name: "asc" },
    });
    if (only && nodes.length === 0) throw new Error(`no node named ${only} with a gateway`);
    let failed = 0;
    for (const node of nodes) {
      if (isRetired(node)) {
        console.log(`${node.name}: retired, skipped`);
        continue;
      }
      const result = await syncGateway(prismaGatewaySyncDeps(), node.id);
      const line = describeSync(result);
      console.log(`${new Date().toISOString()} ${line}`);
      if (result.status !== "failed") continue;
      failed++;
      await prismaEngineLog({ action: "GATEWAY_SYNC_FAILED", toNode: node.name, after: { error: result.error, version: result.version ?? null }, trigger: "SCHEDULED", success: false, error: result.error });
      if (!cron) continue;
      const last = await prisma.engineLog.findFirst({ where: { action: "GATEWAY_SYNC_ALERTED", toNode: node.name }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      if (last && Date.now() - last.createdAt.getTime() < ALERT_EVERY_MS) continue;
      await alertAdmins(`Gateway route sync failing on ${node.name}`, [line, "The gateway keeps its last good table. This job retries every 5 minutes and alerts at most once an hour."].join("\n"));
      await prismaEngineLog({ action: "GATEWAY_SYNC_ALERTED", toNode: node.name, after: { error: result.error }, trigger: "SCHEDULED" });
    }
    if (nodes.length === 0) console.log("no node has a gateway");
    if (failed) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
