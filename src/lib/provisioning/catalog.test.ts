import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDONS, PLANS, planId, upsertPlans } from "../../../prisma/catalog";
import { includedIps } from "./capacityReport";
import { getOsImage, getPresetsForCategory, OS_IMAGES } from "./catalog";

const vps = PLANS.filter((p) => p.category === "VPS");

test("a plan keeps its id when it's renamed: orders and services point at it", () => {
  assert.deepEqual(PLANS.map(planId), [
    "VPS_VPS_BASIC", "VPS_VPS_PRO", "VPS_VPS_ELITE",
    "STORAGE_S4_STARTER", "STORAGE_S4_BASIC", "STORAGE_S4_PRO", "STORAGE_S4_BUSINESS",
    "VPS_DEDICATED_STARTER", "VPS_DEDICATED_BUSINESS", "VPS_DEDICATED_PRO",
    "STORAGE_S4_DEDICATED_500GB", "STORAGE_S4_DEDICATED_1TB", "STORAGE_S4_DEDICATED_5TB", "STORAGE_S4_DEDICATED_10TB",
  ]);
  const flat = PLANS.filter((p) => p.slug.startsWith("DEDICATED_"));
  assert.deepEqual(flat.map((p) => p.name), ["Flat Starter", "Flat Business", "Flat Pro"]);
  assert.ok(flat.every((p) => p.isDedicated));
});

test("the VPS plans say only what provisioning delivers", () => {
  for (const p of vps) {
    assert.equal(includedIps(p.features).count, 1, `${p.name}: provisioning buys one IP`);
    const text = p.features.join(" | ");
    assert.doesNotMatch(text, /guarantee|99\.9|24\/7|backup|snapshot|root|SLA|SSL|monitoring|managed|choice of os/i, p.name);
  }
});

test("Coolify stays on the plans that include it: provisioning reads this bullet to install it", () => {
  const withCoolify = vps.filter((p) => p.features.some((f) => /coolify/i.test(f))).map((p) => p.name);
  assert.deepEqual(withCoolify, ["VPS Pro", "VPS Elite", "Flat Starter", "Flat Business", "Flat Pro"]);
});

test("add-ons nothing delivers aren't sold; Coolify still is", () => {
  const off = ADDONS.filter((a) => a.isActive === false).map((a) => a.slug);
  assert.deepEqual(off, ["dailyBackup", "weeklyBackup", "extraIp"]);
});

test("only Ubuntu 22.04 and a plain install can be ordered", () => {
  assert.deepEqual(OS_IMAGES.map((o) => o.value), ["ubuntu-22.04"]);
  for (const os of ["ubuntu-24.04", "debian-12", "almalinux-9", "rocky-9"]) assert.equal(getOsImage(os), undefined, os);
  assert.deepEqual(getPresetsForCategory("VPS").map((p) => p.value), ["plain"]);
});

function fakePrisma() {
  const calls: { update: Record<string, unknown>; create: Record<string, unknown> }[] = [];
  return { calls, prisma: { plan: { upsert: async (args: (typeof calls)[number]) => void calls.push(args) } } as never };
}

test("the production seed updates a plan's text and nothing else", async () => {
  const { calls, prisma } = fakePrisma();
  await upsertPlans(prisma, { textOnly: true });
  assert.equal(calls.length, PLANS.length);
  for (const [i, c] of calls.entries()) {
    assert.deepEqual(Object.keys(c.update).sort(), ["features", "name"]);
    assert.equal(c.update.name, PLANS[i].name);
    assert.equal(c.create.priceMonthly, PLANS[i].priceMonthly, "a new plan still gets its prices");
  }
});

test("the development seed still updates everything", async () => {
  const { calls, prisma } = fakePrisma();
  await upsertPlans(prisma);
  assert.equal(calls[0].update.priceMonthly, PLANS[0].priceMonthly);
  assert.equal(calls[0].update.isActive, true);
});
