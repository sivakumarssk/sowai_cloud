import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertNode } from "../../../prisma/catalog";
import { HetznerService } from "@/lib/hetzner";
import { CPX22, fakeHetzner, type FakeHetznerConfig } from "@/lib/testing/fakeHetzner";
import { nodeCost, type CostedNode } from "./nodeCosts";

const node: CostedNode = { id: "n1", name: "node-1", hetznerServerId: "42", location: "nbg1", monthlyCost: 330000 };
const server = { id: 42, name: "node-1", server_type: { name: "cpx22" } };

function hetzner(cfg: FakeHetznerConfig, found: { serverType: string } | null = { serverType: server.server_type.name }) {
  const h = new HetznerService({ adapter: fakeHetzner(cfg).adapter, token: "test", pollMs: 1 });
  return { getServer: async () => found, getServerType: (name: string) => h.getServerType(name), ipPrices: (location: string) => h.ipPrices(location) };
}

test("a node's cost is its server plus its Primary IPv4, at the dollar rate", async () => {
  const cost = await nodeCost(node, hetzner({}), 96);
  assert.ok("monthlyPaise" in cost);
  assert.equal(cost.serverType, "cpx22");
  assert.equal(cost.monthlyPaise, Math.ceil(23.49 * 96 * 100));
});

test("a running node on a type Hetzner no longer sells still gets its price", async () => {
  const gone = { ...CPX22, locations: [{ ...CPX22.locations[0], available: false }] };
  const cost = await nodeCost(node, hetzner({ serverTypes: [gone] }), 96);
  assert.ok("monthlyPaise" in cost, JSON.stringify(cost));
});

test("anything that can't be priced is skipped with the reason, never a zero", async () => {
  const skipped = async (n: CostedNode, h: ReturnType<typeof hetzner>) => {
    const cost = await nodeCost(n, h, 96);
    assert.ok("skipped" in cost, JSON.stringify(cost));
    return cost.skipped;
  };
  assert.match(await skipped({ ...node, hetznerServerId: "" }, hetzner({})), /no Hetzner server id/);
  assert.match(await skipped({ ...node, hetznerServerId: "abc" }, hetzner({})), /no Hetzner server id/);
  assert.match(await skipped(node, hetzner({}, null)), /Hetzner has no server 42/);
  assert.match(await skipped(node, hetzner({ serverTypes: [] })), /no price for cpx22 in nbg1/);
  assert.match(await skipped({ ...node, location: "ash" }, hetzner({})), /no price for cpx22 in ash/);
  assert.match(await skipped(node, hetzner({ currency: "EUR" })), /Hetzner reports prices in EUR/);
});

test("the seed sets a node's cost when it creates it, and never overwrites a recomputed one", async () => {
  let saved: { update: Record<string, unknown>; create: Record<string, unknown> } | null = null;
  const prisma = { proxmoxNode: { upsert: async (args: typeof saved) => (saved = args) } } as never;
  await upsertNode(prisma, { PROXMOX_NODE: "pve", PROXMOX_HOST: "1.2.3.4", HETZNER_SERVER_ID: "42", PROXMOX_NODE_MONTHLY_COST_PAISE: "123" });
  assert.equal(saved!.create.monthlyCost, 123);
  assert.equal(saved!.update.monthlyCost, undefined);
});
