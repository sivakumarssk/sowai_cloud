// What a registered node really costs: Hetzner's price today, at the dollar rate. It only reads;
// scripts/node/recompute-node-costs.ts saves the answer when told to.

import { serverTypeOffer, type ApiServerType, type HetznerPrice } from "@/lib/hetzner";
import { serverCost } from "./installNode";

export type CostedNode = { id: string; name: string; hetznerServerId: string; location: string; monthlyCost: number };

export type NodeCostHetzner = {
  getServer(id: number): Promise<{ serverType: string } | null>;
  getServerType(name: string): Promise<ApiServerType | null>;
  ipPrices(location: string): Promise<{ currency: string; primaryIpv4: HetznerPrice | null; floatingIpv4Monthly: number | null }>;
};

export type NodeCost = { node: CostedNode; serverType: string; monthlyPaise: number; hourlyPaise: number } | { node: CostedNode; skipped: string };

/** A node that can't be priced is skipped with the reason, so a saved cost is never replaced by a guess or a zero. */
export async function nodeCost(node: CostedNode, hetzner: NodeCostHetzner, usdToInr: number): Promise<NodeCost> {
  const id = Number(node.hetznerServerId);
  if (!Number.isInteger(id) || id <= 0) return { node, skipped: `no Hetzner server id ("${node.hetznerServerId}")` };
  const server = await hetzner.getServer(id);
  if (!server) return { node, skipped: `Hetzner has no server ${id}` };
  const type = await hetzner.getServerType(server.serverType);
  // The price, not whether it can be bought today: a running node may be on a type Hetzner has stopped selling.
  const price = type && serverTypeOffer(type, node.location).price;
  if (!price) return { node, skipped: `Hetzner lists no price for ${server.serverType} in ${node.location}` };
  const cost = serverCost(server.serverType, price, await hetzner.ipPrices(node.location), { location: node.location, usdToInr }, false);
  if ("error" in cost) return { node, skipped: cost.error };
  return { node, serverType: server.serverType, monthlyPaise: cost.monthlyPaise, hourlyPaise: cost.hourlyPaise };
}
