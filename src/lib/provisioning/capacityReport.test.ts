import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCUMENTED_SIZES, emptied, fitLines, hostLine, hypotheticalNode, unitEconomicsLines } from "./capacityReport";
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

test("unit economics: node cost per VPS Basic against each price, the Floating IP on its own line", () => {
  const lines = unitEconomicsLines({ monthlyCostPaise: 240000, basicFit: 3, prices, floatingIpPaise: 40000 });
  assert.match(lines[0], /\u20b92,400\/month \u00f7 3 VPS Basic = \u20b9800 per container/);
  assert.match(lines[1], /intro 1-year\s+\u20b9599\s+leaves LOSS \u20b9201/);
  assert.match(lines[2], /intro 2-year\s+\u20b9799\s+leaves LOSS \u20b91/);
  assert.match(lines[3], /monthly\s+\u20b91,499\s+leaves \u20b9699/);
  assert.match(lines[4], /renewal\s+\u20b91,299\s+leaves \u20b9499/);
  assert.equal(lines.length, 6);
  assert.match(lines[5], /Floating IP\s+\u20b9400\/month per container, on top\. After it: intro 1-year LOSS \u20b9601, .*monthly \u20b9299, renewal \u20b999/);
});

test("nothing fits: no division by zero. A missing price or IP cost is said, not treated as zero", () => {
  assert.deepEqual(unitEconomicsLines({ monthlyCostPaise: 240000, basicFit: 0, prices, floatingIpPaise: 40000 }), ["  \u20b92,400/month, and no VPS Basic fits, so there's no cost per container"]);
  const lines = unitEconomicsLines({ monthlyCostPaise: 240000, basicFit: 2, prices: { ...prices, intro2Year: null }, floatingIpPaise: null });
  assert.ok(!lines.some((l) => l.includes("intro 2-year")));
  assert.match(lines.at(-1)!, /Floating IP\s+price not available/);
});
