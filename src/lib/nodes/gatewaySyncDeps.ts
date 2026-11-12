// The production side of gatewaySync.ts: the database, and the node's restricted key.
import { prisma } from "@/lib/prisma";
import { runOnHost } from "@/engine/data/hostShell";
import { alertAdmins } from "@/lib/adminAlert";
import { describeSync, nextVersion, ROUTED_STATUSES, syncGateway, type GatewaySyncDeps, type GatewaySyncResult, MAX_GATEWAY_VERSION } from "./gatewaySync";

type NodeRow = { name: string; ip: string; gatewayIpv4: string | null; gatewayVmId: number | null; applied: string | null; issued: string | null };

export function prismaGatewaySyncDeps(): GatewaySyncDeps {
  return {
    issue: (nodeId, nowMs) =>
      prisma.$transaction(async (tx) => {
        // The row lock orders syncs of this node: the next one waits until this version and table are taken.
        const rows = await tx.$queryRaw<NodeRow[]>`
          SELECT "name", "ip", "gatewayIpv4", "gatewayVmId", "gatewayRoutesVersion"::text AS "applied", "gatewayRoutesIssued"::text AS "issued"
          FROM "ProxmoxNode" WHERE "id" = ${nodeId} FOR UPDATE`;
        const n = rows[0];
        if (!n) throw new Error(`no ProxmoxNode with id ${nodeId}`);
        if (!n.gatewayIpv4 || n.gatewayVmId === null) return null;
        const version = nextVersion(nowMs, n.applied === null ? null : BigInt(n.applied), n.issued === null ? null : BigInt(n.issued));
        await tx.proxmoxNode.update({ where: { id: nodeId }, data: { gatewayRoutesIssued: BigInt(version) } });
        const services = await tx.service.findMany({
          where: { nodeId, ipv4Mode: "SHARED", status: { in: [...ROUTED_STATUSES] } },
          select: { id: true, status: true, ipv4Mode: true, privateIpv4: true, publicName: true, routeKey: true, proxmoxVmId: true },
        });
        return { node: { id: nodeId, name: n.name, ip: n.ip, gatewayIpv4: n.gatewayIpv4 }, version, services };
      }),
    send: (node, version, table) => {
      if (!Number.isSafeInteger(version) || version < 0 || version > MAX_GATEWAY_VERSION) throw new Error(`gateway table version ${version} isn't 1 to 15 digits`);
      // The command line carries only the version; the dispatcher refuses anything else.
      return runOnHost(node, `gateway-sync ${version}`, 2 * 60_000, table);
    },
    async applied(nodeId, version) {
      await prisma.$executeRaw`UPDATE "ProxmoxNode" SET "gatewayRoutesVersion" = GREATEST(COALESCE("gatewayRoutesVersion", 0), ${BigInt(version)}) WHERE "id" = ${nodeId}`;
    },
    now: () => Date.now(),
  };
}

/**
 * After a route change (a shared service ready, or cancelled): sync now, and alert on a failure.
 * Never throws; the 5-minute job retries anyway.
 */
export async function syncGatewayAfterChange(nodeId: string, why: string): Promise<GatewaySyncResult> {
  const result = await syncGateway(prismaGatewaySyncDeps(), nodeId);
  const line = describeSync(result);
  if (result.status === "failed") {
    console.error(`[gateway] ${why}: ${line}`);
    await alertAdmins(
      `Gateway route sync failed on ${result.node}`,
      [`After: ${why}`, line, "The gateway keeps its last good table. scripts/node/gateway-sync.ts retries every 5 minutes; run it by hand to see the current state."].join("\n")
    ).catch((err) => console.error("[gateway] alert failed:", err));
  } else {
    console.log(`[gateway] ${why}: ${line}`);
  }
  return result;
}
