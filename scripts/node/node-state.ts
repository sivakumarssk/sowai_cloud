/**
 * Retire a node, or open one for new clients.
 *
 *   npx tsx scripts/node/node-state.ts --name sowsi-proxmox-01 --retire                              # dry run
 *   npx tsx scripts/node/node-state.ts --name sowsi-proxmox-01 --retire --apply --approved-by <name>
 *   npx tsx scripts/node/node-state.ts --name sowsi-proxmox-02 --open                                # dry run
 *   npx tsx scripts/node/node-state.ts --name sowsi-proxmox-02 --open --apply --approved-by <name>
 *
 * --retire sets DECOMMISSIONING and closes the node; it refuses while the node has a live service,
 * a volume, an open migration or an open engine approval. The row and its history stay.
 * --open sets READY (from PROVISIONING) and opens the node; it refuses a retired node, or one
 * without its own API token or IPv6 subnet. Changes only the database, never a server.
 */
import { config as loadEnv } from "dotenv";
import type { NodeStatus } from "@prisma/client";
import { exitUnlessEnvironment } from "../lib/env";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
exitUnlessEnvironment();

const argv = process.argv.slice(2);
const value = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

(async () => {
  const name = value("--name");
  const actions = (["retire", "open"] as const).filter((a) => argv.includes(`--${a}`));
  if (!name || actions.length !== 1) throw new Error("usage: node-state.ts --name <node> (--retire | --open) [--apply --approved-by <name>]");
  const action = actions[0];
  const apply = argv.includes("--apply");
  const approvedBy = value("--approved-by") ?? "";
  if (apply && !approvedBy) throw new Error("--apply needs --approved-by <name>");

  const { prisma } = await import("../../src/lib/prisma");
  const { applyNodeState, planNodeState } = await import("../../src/lib/nodes/nodeState");
  const deps: import("../../src/lib/nodes/nodeState").NodeStateDeps = {
    async findNode(n) {
      const row = await prisma.proxmoxNode.findUnique({ where: { name: n }, select: { id: true, name: true, status: true, acceptNewClients: true, hetznerServerId: true, ipv6Subnet: true, apiTokenId: true, apiTokenSecret: true } });
      if (!row) return null;
      const { apiTokenId, apiTokenSecret, ...rest } = row;
      return { ...rest, hasOwnToken: Boolean(apiTokenId && apiTokenSecret) };
    },
    liveServices: (nodeId) => prisma.service.findMany({ where: { nodeId, status: { notIn: ["DELETED", "CANCELLED"] } }, select: { id: true, status: true } }),
    liveVolumes: (nodeId) => prisma.hetznerVolume.findMany({ where: { nodeId, status: { not: "DELETED" } }, select: { id: true, status: true } }),
    openMigrations: (n) => prisma.migration.count({ where: { OR: [{ fromNode: n }, { toNode: n }], status: { in: ["SCHEDULED", "IN_PROGRESS"] } } }),
    openApprovals: (n) => prisma.engineApproval.count({ where: { subject: `node:${n}`, status: { in: ["PENDING", "APPROVED"] } } }),
    async apply(node, change, log) {
      await prisma.$transaction([
        prisma.proxmoxNode.update({ where: { id: node.id }, data: { status: change.status as NodeStatus, acceptNewClients: change.acceptNewClients } }),
        prisma.engineLog.create({
          data: { action: log.action, toNode: node.name, trigger: "MANUAL", before: { status: node.status, acceptNewClients: node.acceptNewClients }, after: { ...change, approvedBy: log.approvedBy } },
        }),
      ]);
    },
  };

  try {
    const plan = await planNodeState(deps, name, action);
    for (const line of plan.lines) console.log(`  ${line}`);
    for (const p of plan.problems) console.log(`  REFUSED: ${p}`);
    if (!plan.ok) return void (process.exitCode = 1);
    if (!apply) return console.log(plan.change ? "\nDry run: nothing changed. Add --apply --approved-by <name> to make this change." : "\nNothing to change.");
    console.log(`\nDone: ${await applyNodeState(deps, plan, action, approvedBy)}`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
