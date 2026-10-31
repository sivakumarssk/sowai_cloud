import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCUMENTED_SIZES, breakEven, emptied, fitLines, hostLine, hypotheticalNode, includedIps, inrRate, planEconomicsLines, type EconomicsPlan } from "./capacityReport";
import { fitCount, type NodeLoad } from "./placement";

const config = { ramOvercommit: 1, diskPoolReserveGB: 20, hostRamReserveMB: 1536 };
const plans = [
  { name: "VPS Basic", need: { ramMB: 2048, diskGB: 40 } },
  { name: "VPS Pro", need: { ramMB: 4096, diskGB: 80 } },
  { name: "VPS Elite", need: { ramMB: 8192, diskGB: 160 } },
  { name: "Dedicated Pro", need: { ramMB: 16384, diskGB: 320 } },
];
const size = (type: string) => hypotheticalNode(DOCUMENTED_SIZES.find((s) => s.type === type)!);
const counts = (n: NodeLoad) => plans.map((p) => fitCount(n, p.need, config));

test("documented sizes, host reserve and disk reserve applied, capped at six containers", () => {
  assert.deepEqual(counts(size("cpx22")), [1, 0, 0, 0]);
  assert.deepEqual(counts(size("cpx32")), [3, 1, 0, 0]);
  assert.deepEqual(counts(size("cpx42")), [6, 3, 1, 0]);
  assert.deepEqual(counts(size("cpx52")), [6, 5, 2, 1]);
});

test("the real cpx22, as registered: one VPS Basic and nothing else", () => {
  const measured = { ...size("cpx22"), physicalRamMB: 3817, physicalDiskGB: 74 };
  assert.deepEqual(counts(measured), [1, 0, 0, 0]);
  assert.equal(hostLine(measured, config), "host 1536 MB (reserve) \u00b7 usable 2281 MB RAM, 54 GB disk");
});

test("a closed node fits nothing now, and says what it would take once opened", () => {
  const closed = { ...size("cpx22"), status: "PROVISIONING", acceptNewClients: false };
  assert.match(fitLines(closed, plans, config)[0], /VPS Basic\s+0 now, 1 if opened/);
  assert.match(fitLines(closed, plans, config)[1], /VPS Pro\s+0 now, 0 if opened/);
  assert.match(fitLines(size("cpx22"), plans, config)[0], /VPS Basic\s+1$/);
});

test("capacity ignores what a node holds today, but keeps its measured host figure", () => {
  const busy: NodeLoad = { ...size("cpx32"), settled: { ramMB: 6144, diskGB: 120, count: 3 }, monitor: { allocatedRamMB: 6144, allocatedDiskGB: 120, containerCount: 3, hostUsedRamMB: 900 } };
  assert.equal(fitCount(busy, plans[0].need, config), 0);
  assert.equal(fitCount(emptied(busy), plans[0].need, config), 3);
  assert.equal(emptied(busy).monitor!.hostUsedRamMB, 900);
  assert.match(hostLine(emptied(busy), config), /host 900 MB \(measured\)/);
});

const prices = { intro1Year: 59900, intro2Year: 79900, monthly: 149900, renewal: 129900 };
const basic: EconomicsPlan = { name: "VPS Basic", need: { ramMB: 2048, diskGB: 40 }, isDedicated: false, prices, ips: { count: 1, stated: true } };
const servers = (...sizes: [string, number][]) => sizes.map(([type, monthlyCostPaise]) => ({ name: type, node: size(type), monthlyCostPaise, estimate: true }));
const input = { config, overcommit: 1.5, floatingIpPaise: 35700 };
const line = (lines: string[], start: RegExp) => lines.find((l) => start.test(l)) ?? assert.fail(`no line ${start}`);

test("each server shows the fit with and without overcommit, what holds it, the cost and the profit after IPs", () => {
  const lines = planEconomicsLines(basic, servers(["cpx42", 704900]), input);
  assert.match(lines[0], /VPS Basic \u00b7 2 GB, 40 GB \u00b7 intro 1-year \u20b9599, intro 2-year \u20b9799, monthly \u20b91,499, renewal \u20b91,299/);
  const plain = line(lines, /cpx42 est\.\s+\u00d71 /);
  assert.match(plain, /\u00d71\s+6\s+container limit\s+\u20b91,174\.84?\s/);
  // 149900 - ceil(704900 / 6) - 35700 = -3284
  assert.match(plain, /-\u20b932\.84/);
  assert.match(line(lines, /cpx42 est\.\s+\u00d71\.5 /), /\u00d71\.5\s+6\s+container limit/, "more RAM doesn't lift the container limit");
});

test("overcommit only helps while RAM is what holds the plan", () => {
  const big = { ...basic, need: { ramMB: 4096, diskGB: 20 } };
  const lines = planEconomicsLines(big, servers(["cpx32", 364900]), input);
  assert.match(line(lines, /\u00d71 /), /\u00d71\s+1\s+RAM/);
  assert.match(line(lines, /\u00d71\.5 /), /\u00d71\.5\s+2\s+RAM/);
  const diskHeld = planEconomicsLines(basic, servers(["cpx22", 234900]), input);
  assert.match(line(diskHeld, /\u00d71\.5 /), /\u00d71\.5\s+1\s+RAM, disk/);
});

test("break-even: containers a node needs at a price, after the IPs, and never if the IPs cost more", () => {
  assert.equal(breakEven(364900, 149900, 35700), 4);
  assert.equal(breakEven(364900, 149900, 0), 3);
  assert.equal(breakEven(364900, 35700, 35700), null);
  assert.equal(breakEven(364900, 30000, 35700), null);
  // At the break-even count the profit is never below zero, and one fewer always is.
  for (const [cost, price, ips] of [[364900, 149900, 35700], [704900, 129900, 35700], [234900, 59900, 0]]) {
    const n = breakEven(cost, price, ips)!;
    assert.ok(price - Math.ceil(cost / n) - ips >= 0);
    assert.ok(n === 1 || price - Math.ceil(cost / (n - 1)) - ips < 0);
  }
  const lines = planEconomicsLines({ ...basic, prices: { ...prices, intro1Year: 30000 } }, servers(["cpx32", 364900]), input);
  assert.match(line(lines, /\u00d71 /), /never \/ 9 \/ 4 \/ 4$/);
});

test("a plan that loses at its best density is flagged, naming the prices and the density", () => {
  const some = planEconomicsLines(basic, servers(["cpx32", 270000]), input);
  assert.match(some.at(-1)!, /LOSES MONEY at intro 1-year, intro 2-year, at its best density \(cpx32 est\., RAM \u00d71, 3 per node, \u20b9900 each\)/);
  const every = planEconomicsLines(basic, servers(["cpx22", 234900]), input);
  assert.match(every.at(-1)!, /LOSES MONEY at every price, at its best density \(cpx22 est\./);
  const fine = planEconomicsLines(basic, servers(["cpx42", 60000]), input);
  assert.match(fine.at(-1)!, /^ {2}OK: makes money at every price at its best density \(cpx42 est\./);
  assert.match(planEconomicsLines({ ...basic, need: { ramMB: 65536, diskGB: 40 } }, servers(["cpx22", 234900]), input).at(-1)!, /DOESN'T FIT on any size/);
});

test("best density picks the cheapest customer across sizes, and the overcommit row when it wins", () => {
  const plan = { ...basic, need: { ramMB: 4096, diskGB: 20 } };
  const last = planEconomicsLines(plan, servers(["cpx22", 234900], ["cpx32", 364900]), input).at(-1)!;
  assert.match(last, /cpx32 est\., RAM \u00d71\.5, 2 per node/);
});

test("guaranteed RAM is never counted as overcommitted, even where that would look better", () => {
  const plan = { ...basic, name: "Dedicated", isDedicated: true, need: { ramMB: 4096, diskGB: 20 } };
  const lines = planEconomicsLines(plan, servers(["cpx32", 364900]), input);
  assert.match(line(lines, /\u00d71\.5 /), /not for sale: this plan's RAM is guaranteed/);
  assert.match(lines.at(-1)!, /cpx32 est\., RAM \u00d71, 1 per node/);
});

test("the Floating IPs get their own line, and what's promised is what's counted", () => {
  const two = { ...basic, ips: { count: 2, stated: true } };
  const lines = planEconomicsLines(two, servers(["cpx32", 300000]), input);
  assert.match(lines[1], /Floating IPs {2}2 included; provisioning only buys 1 today: \u20b9714\/month per customer/);
  // 149900 - 100000 - 71400 = -21500
  assert.match(line(lines, /\u00d71 /), /-\u20b9215 /);
  assert.doesNotMatch(planEconomicsLines(basic, servers(["cpx32", 300000]), input)[1], /only buys/);
  assert.match(planEconomicsLines({ ...basic, ips: { count: 1, stated: false } }, servers(["cpx32", 300000]), input)[1], /the plan doesn't say/);
  assert.match(planEconomicsLines(basic, servers(["cpx32", 300000]), { ...input, floatingIpPaise: null })[1], /NOT counted/);
});

test("a price the plan doesn't have is left out, not treated as zero", () => {
  const lines = planEconomicsLines({ ...basic, prices: { ...prices, intro2Year: null } }, servers(["cpx32", 300000]), input);
  assert.ok(!lines.some((l) => l.includes("intro 2-year")));
  assert.doesNotMatch(lines.at(-1)!, /intro 2-year/);
});

test("the included IPs come from the plan's own bullets", () => {
  assert.deepEqual(includedIps(["2 vCPU Cores", "1 Dedicated IP"]), { count: 1, stated: true });
  assert.deepEqual(includedIps(["3 Dedicated IPs"]), { count: 3, stated: true });
  assert.deepEqual(includedIps(["Daily Backups Included", "99.9% SLA Uptime"]), { count: 1, stated: false });
});

test("the rate follows the currency Hetzner reports; Hetzner never gives a rate", () => {
  assert.deepEqual(inrRate("EUR", { HETZNER_EUR_TO_INR: "104.5" }), { rate: 104.5, source: "Hetzner reports EUR, \u20b9104.5 from HETZNER_EUR_TO_INR" });
  assert.deepEqual(inrRate("EUR", { HETZNER_EUR_TO_INR: "104.5 # today" }), { rate: 104.5, source: "Hetzner reports EUR, \u20b9104.5 from HETZNER_EUR_TO_INR" });
  const fallback = inrRate("EUR", {});
  assert.ok("rate" in fallback && fallback.rate === 100);
  assert.match((fallback as { source: string }).source, /DEFAULT/, "a default is said out loud");
  assert.deepEqual(inrRate("USD", { HETZNER_USD_TO_INR: "88" }), { rate: 88, source: "Hetzner reports USD, \u20b988 from HETZNER_USD_TO_INR" });
  assert.deepEqual(inrRate("USD", { HETZNER_EUR_TO_INR: "104" }), { problem: "Hetzner reports USD, and HETZNER_USD_TO_INR isn't set" }, "the euro rate isn't used for dollars");
  assert.deepEqual(inrRate("INR", {}), { rate: 1, source: "Hetzner reports INR" });
  assert.match((inrRate("EUR", { HETZNER_EUR_TO_INR: "lots" }) as { problem: string }).problem, /must be a positive number/);
});
