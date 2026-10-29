import { prisma } from "@/lib/prisma";
import { razorpay } from "@/lib/razorpay";
import { hetzner } from "@/lib/hetzner";
import { proxmox, proxmoxForNode, ProxmoxError } from "@/lib/proxmox";
import { provisionVPS } from "@/lib/provisioning/provisionVPS";
import { chooseNode } from "@/lib/provisioning/placement";
import { nodeLoads, placementConfig } from "@/lib/provisioning/placementDeps";
import { prismaEngineLog } from "@/engine/data/engineLog";
import type { ReprovisionDeps } from "./reprovision";

/** The label provisionVPS gives a service's container hostname and Floating IP. */
const label = (serviceId: string) => `sowsi-${serviceId}`;

export function prismaReprovisionDeps(): ReprovisionDeps {
  return {
    async load(serviceId) {
      const s = await prisma.service.findUnique({
        where: { id: serviceId },
        include: {
          plan: { select: { name: true, category: true, ramGB: true, storageGB: true } },
          user: { select: { name: true, email: true } },
          node: { select: { name: true } },
          subscriptions: { orderBy: { createdAt: "desc" }, take: 1, select: { razorpaySubscriptionId: true, status: true } },
          payments: { select: { status: true } },
        },
      });
      if (!s) return null;
      const sub = s.subscriptions[0];
      return {
        id: s.id,
        status: s.status,
        provisioningPct: s.provisioningPct,
        provisioningStep: s.provisioningStep,
        updatedAt: s.updatedAt,
        plan: s.plan,
        customer: `${s.user.name} <${s.user.email}>`,
        proxmoxVmId: s.proxmoxVmId,
        nodeName: s.node?.name ?? null,
        hetznerFloatingIpId: s.hetznerFloatingIpId,
        serverIp: s.serverIp,
        ipv6Address: s.ipv6Address,
        credentials: { sshUsername: !!s.sshUsername, sshPassword: !!s.sshPassword, panelUrl: !!s.panelUrl, panelPassword: !!s.panelPassword },
        subscription: sub ? { razorpaySubscriptionId: sub.razorpaySubscriptionId, dbStatus: sub.status } : null,
        paymentStatuses: s.payments.map((p) => p.status),
      };
    },

    async findContainers(s) {
      const found: string[] = [];
      // 1. Its recorded vmid on its recorded node (or the default node for old rows).
      if (s.proxmoxVmId) {
        const node = s.nodeName ? await prisma.proxmoxNode.findUnique({ where: { name: s.nodeName }, select: { name: true, ip: true } }) : null;
        const client = node ? proxmoxForNode(node) : proxmox;
        try {
          const st = await client.getLXCStatus(Number(s.proxmoxVmId));
          found.push(`vmid ${s.proxmoxVmId} on ${node?.name ?? "the default node"} (${st.status})`);
        } catch (err) {
          if (!(err instanceof ProxmoxError && /does not exist/i.test(err.message))) throw err;
        }
      }
      // 2. Any container named after it, on every registered node.
      for (const node of await prisma.proxmoxNode.findMany({ select: { name: true, ip: true } })) {
        for (const ct of await proxmoxForNode(node).listLXC()) {
          if (ct.name === label(s.id)) found.push(`vmid ${ct.vmid} "${ct.name}" on ${node.name} (${ct.status})`);
        }
      }
      return [...new Set(found)];
    },

    async findFloatingIps(s) {
      return (await hetzner.listFloatingIPs())
        .filter((ip) => String(ip.id) === s.hetznerFloatingIpId || ip.description === label(s.id))
        .map((ip) => `${ip.ip} (id ${ip.id}, ${ip.server ? `assigned to server ${ip.server}` : "unassigned"})`);
    },

    // Read only: nothing is written to the Subscription row.
    razorpaySubscriptionStatus: async (id) => String((await razorpay.subscriptions.fetch(id)).status),

    async placement(need) {
      const choice = chooseNode(await nodeLoads(prisma), need, placementConfig());
      return choice.node ? { node: choice.node.name } : { node: null, reason: choice.reasons.join("; ") };
    },

    async reset(s, data) {
      const { count } = await prisma.service.updateMany({ where: { id: s.id, status: s.status as never, updatedAt: s.updatedAt }, data });
      return count === 1;
    },

    provision: (serviceId) => provisionVPS(serviceId, { refundOnFailure: false }),

    async result(serviceId) {
      const s = await prisma.service.findUniqueOrThrow({ where: { id: serviceId }, include: { node: { select: { name: true } } } });
      return { status: s.status, provisioningStep: s.provisioningStep, provisionError: s.provisionError, nodeName: s.node?.name ?? null, proxmoxVmId: s.proxmoxVmId, serverIp: s.serverIp };
    },

    log: (e) => prismaEngineLog({ ...e, trigger: "MANUAL" }),
  };
}
