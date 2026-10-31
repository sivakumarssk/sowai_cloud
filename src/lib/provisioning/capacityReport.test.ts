import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCUMENTED_SIZES, breakEven, emptied, fitLines, hostLine, hypotheticalNode, includedIps, inrRate, parseMargin, planEconomicsLines, priceForMargin, type EconomicsPlan } from "./capacityReport";
import { fitCount, type NodeLoad } from "./placement";

const config = { ramOvercommit: 1, diskOvercommit: 1, diskPoolReserveGB: 20, hostRamReserveMB: 1536 };
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
  assert.match(hostLine(emptied(busy), config), /host 1536 MB \(reserve, measured 900 MB\)/);
  const heavy = { ...busy, monitor: { ...busy.monitor!, hostUsedRamMB: 2000 } };
  assert.match(hostLine(heavy, config), /host 2000 MB \(measured\)/);
});

const prices = { intro1Year: 59900, intro2Year: 79900, monthly: 149900, renewal: 129900 };
const basic: EconomicsPlan = { name: "VPS Basic", need: { ramMB: 2048, diskGB: 40 }, isDedicated: false, prices, ips: { count: 1, stated: true } };
const servers = (...sizes: [string, number][]) => sizes.map(([type, monthlyCostPaise]) => ({ name: type, node: size(type), monthlyCostPaise, estimate: true }));
const input = { config, overcommit: 1.5, diskOvercommit: 1, marginPct: 0, floatingIpPaise: 35700 };
const line = (lines: string[], start: RegExp) => lines.find((l) => start.test(l)) ?? assert.fail(`no line ${start}`);

test("each server shows the fit with and without overcommit, what holds it, the cost and the profit after IPs", () => {
  const lines = planEconomicsLines(basic, servers(["cpx42", 704900]), input);
  assert.match(lines[0], /VPS Basic \u00b7 2 GB, 40 GB \u00b7 intro 1-year \u20b9599, intro 2-year \u20b9799, monthly \u20b91,499, renewal \u20b91,299/);
  const plain = line(lines, /cpx42 est\.\s+\u00d71 /);
  assert.match(plain, /\u00d71\s+6\s+container limit\s+\u20b91,174\.84?\s/);
  // 149900 - ceil(704900 / 6) - 35700 = -3284
  assert.match(plain, /-\u20b932\.84/);
  assert.match(line(lines, /cpx42 est\.\s+\u00d71\.5 /), /\u00d71\.5\s+\u00d71\s+6\s+container limit/, "more RAM doesn't lift the container limit");
});

test("overcommit only helps while RAM is what holds the plan", () => {
  const big = { ...basic, need: { ramMB: 4096, diskGB: 20 } };
  const lines = planEconomicsLines(big, servers(["cpx32", 364900]), input);
  assert.match(line(lines, /\u00d71 /), /\u00d71\s+1\s+RAM/);
  assert.match(line(lines, /\u00d71\.5 /), /\u00d71\.5\s+\u00d71\s+2\s+RAM/);
  const diskHeld = planEconomicsLines(basic, servers(["cpx22", 234900]), input);
  assert.match(line(diskHeld, /\u00d71\.5 /), /\u00d71\.5\s+\u00d71\s+1\s+RAM, disk/);
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
  assert.match(line(lines, /\u00d71\.5 /), /not for sale: this plan's resources are guaranteed/);
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
  assert.deepEqual(includedIps(["2 vCPU Cores", "1 IPv4 address"]), { count: 1, stated: true });
  assert.deepEqual(includedIps(["1 Dedicated IP"]), { count: 1, stated: true }, "a plan row from before the seed");
  assert.deepEqual(includedIps(["3 Dedicated IPs"]), { count: 3, stated: true });
  assert.deepEqual(includedIps(["Daily Backups Included", "99.9% SLA Uptime"]), { count: 1, stated: false });
});

test("the rate follows the currency Hetzner reports; Hetzner never gives a rate", () => {
  const usd = { rate: 96, source: "Hetzner reports USD, \u20b996 per USD from HETZNER_USD_TO_INR" };
  assert.deepEqual(inrRate("USD", { HETZNER_USD_TO_INR: "96" }), usd, "a setting carries no warning");
  assert.deepEqual(inrRate("USD", { HETZNER_USD_TO_INR: "96 # today" }), usd);
  assert.deepEqual(inrRate("EUR", { HETZNER_EUR_TO_INR: "104.5" }), { rate: 104.5, source: "Hetzner reports EUR, \u20b9104.5 per EUR from HETZNER_EUR_TO_INR" });
  const fallback = { rate: 96, source: "Hetzner reports USD, \u20b996 per USD by default", warning: "WARNING: \u20b996 per USD is a default rate, because HETZNER_USD_TO_INR isn't set" };
  assert.deepEqual(inrRate("USD", {}), fallback, "a default is said out loud");
  assert.deepEqual(inrRate("USD", { HETZNER_EUR_TO_INR: "104" }), fallback, "the euro rate isn't used for dollars");
  assert.match((inrRate("EUR", {}) as { warning: string }).warning, /\u20b9100 per EUR is a default rate/);
  assert.deepEqual(inrRate("GBP", {}), { problem: "Hetzner reports GBP, and HETZNER_GBP_TO_INR isn't set" }, "no rate is invented");
  assert.deepEqual(inrRate("INR", {}), { rate: 1, source: "Hetzner reports INR" });
  assert.match((inrRate("EUR", { HETZNER_EUR_TO_INR: "lots" }) as { problem: string }).problem, /must be a positive number/);
});

const thin = { ...input, diskOvercommit: 1.5 };
const heavyDisk: EconomicsPlan = { ...basic, need: { ramMB: 1024, diskGB: 100 } };

test("thin-disk rows are extra, marked, and appear only when asked for", () => {
  assert.equal(planEconomicsLines(basic, servers(["cpx32", 364900]), input).filter((l) => /cpx32 est\.\s+\u00d7/.test(l)).length, 2);
  const lines = planEconomicsLines(heavyDisk, servers(["cpx32", 364900]), thin);
  const rows = lines.filter((l) => /cpx32 est\.\s+\u00d7/.test(l));
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((l) => l.includes("THIN DISK, not enabled")).length, 2);
  assert.match(rows[0], /\u00d71\s+\u00d71\s+1\s+disk/);
  assert.match(rows[2], /\u00d71\s+\u00d71\.5\s+2\s+disk.*THIN DISK, not enabled$/, "thin disk: (160 - 20) x 1.5 = 210 GB");
  assert.ok(!lines.some((l) => /\u00d71\s+\u00d71\s.*THIN DISK/.test(l)), "a row with real disks is never marked");
});

test("a thin disk that isn't enabled never changes the verdict or the price; it gets its own line", () => {
  const lines = planEconomicsLines(heavyDisk, servers(["cpx32", 364900]), thin);
  assert.match(lines.at(-1)!, /at its best density \(cpx32 est\., RAM \u00d71, 1 per node/);
  assert.match(line(lines, /Break-even price/), /RAM \u00d71, 1 per node/);
  assert.match(line(lines, /Thin disks, not enabled/), /thin disk \u00d71\.5, 2 per node, \u20b91,824\.5 each: .*monthly -\u20b9682\.5/, "1,499 - 1,824.50 - 357");
});

test("thin disks count once enabled, and the line about them goes away", () => {
  const on = { ...thin, config: { ...config, diskOvercommit: 1.5 } };
  const lines = planEconomicsLines(heavyDisk, servers(["cpx32", 364900]), on);
  assert.ok(!lines.some((l) => l.includes("not enabled")));
  assert.match(lines.at(-1)!, /thin disk \u00d71\.5, 2 per node/);
});

test("thin disks don't help a plan held by RAM or the container limit, and that's said", () => {
  const lines = planEconomicsLines(basic, servers(["cpx42", 704900]), thin);
  assert.equal(line(lines, /Thin disks/), "  Thin disks, not enabled: no better than the density above");
});

test("a guaranteed plan is never thin: the row says so, and there's no thin line", () => {
  const plan = { ...heavyDisk, isDedicated: true };
  const lines = planEconomicsLines(plan, servers(["cpx32", 364900]), thin);
  assert.match(line(lines, /\u00d71\s+\u00d71\.5\s/), /THIN DISK, not enabled {2}not for sale/);
  assert.ok(!lines.some((l) => l.includes("Thin disks")));
  assert.match(lines.at(-1)!, /RAM \u00d71, 1 per node/);
});

test("the price for a margin: margin on the price, rounded up so it's never short", () => {
  assert.equal(priceForMargin(70000, 30), 100000);
  assert.equal(priceForMargin(70000, 0), 70000);
  assert.equal(priceForMargin(100001, 50), 200002);
  for (const [cost, margin] of [[117485, 30], [153057, 12.5], [999, 99]]) {
    const price = priceForMargin(cost, margin);
    assert.ok((price - cost) / price >= margin / 100 - 1e-9, "the margin is reached");
    assert.ok((price - 1 - cost) / (price - 1) < margin / 100, "and a paisa less misses it");
  }
});

test("each plan gets the price with its Floating IPs and without, at its best density", () => {
  const two = { ...basic, ips: { count: 2, stated: true } };
  // Cost 1,000 a customer; with two IPs at 357 it's 1,714.
  const lines = planEconomicsLines(two, servers(["cpx32", 300000]), { ...input, marginPct: 30 });
  assert.match(line(lines, /Price for a 30% margin/), /\u20b92,448\.58 with Floating IPs, \u20b91,428\.58 without, at cpx32 est\., RAM \u00d71, 3 per node/);
  assert.match(line(planEconomicsLines(two, servers(["cpx32", 300000]), input), /Break-even price/), /\u20b91,714 with Floating IPs, \u20b91,000 without/);
  const noIpPrice = planEconomicsLines(two, servers(["cpx32", 300000]), { ...input, floatingIpPaise: null });
  assert.match(line(noIpPrice, /Break-even price/), /Floating IP price not available, \u20b91,000 without them/);
  const noFit = planEconomicsLines({ ...basic, need: { ramMB: 65536, diskGB: 40 } }, servers(["cpx22", 234900]), input);
  assert.ok(!noFit.some((l) => l.includes("Break-even price")), "nothing fits, so no price");
});

test("--margin is a percentage from 0 to under 100, and a bad one stops the report", () => {
  assert.equal(parseMargin([]), 0);
  assert.equal(parseMargin(["--margin", "30"]), 30);
  assert.equal(parseMargin(["--margin=12.5"]), 12.5);
  assert.equal(parseMargin(["--margin", "0"]), 0);
  for (const bad of [["--margin"], ["--margin", "100"], ["--margin", "-5"], ["--margin", "lots"], ["--margin="], ["--margin", "30%"]]) {
    assert.throws(() => parseMargin(bad), /--margin must be a percentage/, bad.join(" "));
  }
});
