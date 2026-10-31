// The numbers behind scripts/engine/placement.ts: how many containers fit, and what one
// costs. It only reads; nothing here places, buys or changes anything.

import { closedReason, fitCount, hostRamMB, usableRamMB, type Need, type NodeLoad, type PlacementConfig } from "./placement";

export type ReportPlan = { name: string; need: Need };
/** Monthly rates in paise, as on the Plan row. */
export type VpsPrices = { intro1Year: number | null; intro2Year: number | null; monthly: number | null; renewal: number | null };

/** Hetzner's documented sizes. A real node measures less: a cpx22 sold as 4 GB / 80 GB reports 3817 MB / 74 GB. */
export const DOCUMENTED_SIZES = [
  { type: "cpx22", ramGB: 4, diskGB: 80 },
  { type: "cpx32", ramGB: 8, diskGB: 160 },
  { type: "cpx42", ramGB: 16, diskGB: 320 },
  { type: "cpx52", ramGB: 24, diskGB: 480 },
] as const;

/** Shown next to "no overcommit" when NODE_RAM_OVERCOMMIT doesn't set one. Illustrative, not advice. */
export const ILLUSTRATIVE_OVERCOMMIT = 1.5;

/** The column default on ProxmoxNode. */
const DEFAULT_MAX_CONTAINERS = 6;

const nothing = { ramMB: 0, diskGB: 0, count: 0 };

const inr = (paise: number) => `\u20b9${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** An empty, open node of a documented size: nothing measured, so it gets the reserve. */
export function hypotheticalNode(size: (typeof DOCUMENTED_SIZES)[number]): NodeLoad {
  return {
    id: size.type,
    name: size.type,
    ip: "",
    hetznerServerId: "",
    location: "",
    ipv6Subnet: "hypothetical",
    acceptNewClients: true,
    status: "READY",
    physicalRamMB: size.ramGB * 1024,
    physicalDiskGB: size.diskGB,
    maxContainers: DEFAULT_MAX_CONTAINERS,
    monitor: null,
    settled: { ...nothing },
    inFlight: { ...nothing },
  };
}

/** The same node open and with nothing on it: its capacity, whatever it holds today. */
export function emptied(node: NodeLoad): NodeLoad {
  return {
    ...node,
    acceptNewClients: true,
    status: "READY",
    monitor: node.monitor && { allocatedRamMB: 0, allocatedDiskGB: 0, containerCount: 0, hostUsedRamMB: node.monitor.hostUsedRamMB },
    settled: { ...nothing },
    inFlight: { ...nothing },
  };
}

export function hostLine(node: NodeLoad, config: PlacementConfig): string {
  const source = node.monitor?.hostUsedRamMB == null ? "reserve" : "measured";
  return `host ${hostRamMB(node, config)} MB (${source}) \u00b7 usable ${usableRamMB(node, config)} MB RAM, ${node.physicalDiskGB - config.diskPoolReserveGB} GB disk`;
}

/** One line per plan: how many fit now, and for a closed node how many once it's opened. */
export function fitLines(node: NodeLoad, plans: ReportPlan[], config: PlacementConfig): string[] {
  const closed = closedReason(node) !== null;
  return plans.map((p) => {
    const now = fitCount(node, p.need, config);
    return `  ${p.name.padEnd(20)} ${closed ? `0 now, ${fitCount({ ...node, acceptNewClients: true, status: "READY" }, p.need, config)} if opened` : now}`;
  });
}

const PRICES: [keyof VpsPrices, string][] = [
  ["intro1Year", "intro 1-year"],
  ["intro2Year", "intro 2-year"],
  ["monthly", "monthly"],
  ["renewal", "renewal"],
];

/** What provisioning buys for every VPS, whatever the plan says. */
const FLOATING_IPS_PROVISIONED = 1;

/** The IPs a plan promises, read from its feature bullets. Plans that don't say get what provisioning buys. */
export function includedIps(features: string[]): { count: number; stated: boolean } {
  for (const feature of features) {
    const m = /^(\d+) Dedicated IPs?$/i.exec(feature.trim());
    if (m) return { count: Number(m[1]), stated: true };
  }
  return { count: FLOATING_IPS_PROVISIONED, stated: false };
}

/**
 * Rupees per unit of the currency Hetzner reports. Hetzner gives the currency, never a rate, so
 * the rate is a setting for that currency. Only EUR has a default, because it's the one Hetzner uses today.
 */
export function inrRate(currency: string, env: Record<string, string | undefined>): { rate: number; source: string } | { problem: string } {
  if (currency === "INR") return { rate: 1, source: "Hetzner reports INR" };
  const name = `HETZNER_${currency}_TO_INR`;
  const raw = env[name]?.split("#")[0].trim();
  if (raw) {
    const rate = Number(raw);
    return rate > 0 ? { rate, source: `Hetzner reports ${currency}, \u20b9${rate} from ${name}` } : { problem: `${name} must be a positive number, got "${raw}"` };
  }
  if (currency === "EUR") return { rate: 100, source: `Hetzner reports EUR, \u20b9100 is the DEFAULT: ${name} isn't set` };
  return { problem: `Hetzner reports ${currency}, and ${name} isn't set` };
}

export type EconomicsPlan = ReportPlan & { isDedicated: boolean; prices: VpsPrices; ips: { count: number; stated: boolean } };
export type EconomicsServer = { name: string; node: NodeLoad; monthlyCostPaise: number; estimate: boolean };
export type EconomicsInput = {
  config: PlacementConfig;
  /** The overcommit shown next to no overcommit. */
  overcommit: number;
  /** Null when Hetzner's price isn't known: the IPs are then left out, and that's said. */
  floatingIpPaise: number | null;
};

type Row = { server: EconomicsServer; overcommit: number; fit: number; heldBy: string; costEach: number | null; profits: Partial<Record<keyof VpsPrices, number>> };

/** Containers a node needs for this price to cover it, or null if the IPs alone cost more than the price. */
export function breakEven(monthlyCostPaise: number, price: number, ipsPaise: number): number | null {
  const left = price - ipsPaise;
  return left > 0 ? Math.ceil(monthlyCostPaise / left) : null;
}

function heldBy(node: NodeLoad, need: Need, config: PlacementConfig): string {
  const limits: [string, number][] = [
    ["RAM", Math.floor(usableRamMB(node, config) / need.ramMB)],
    ["disk", Math.floor((node.physicalDiskGB - config.diskPoolReserveGB) / need.diskGB)],
    ["container limit", node.maxContainers],
  ];
  const lowest = Math.min(...limits.map(([, n]) => n));
  return limits.filter(([, n]) => n === lowest).map(([name]) => name).join(", ");
}

function row(server: EconomicsServer, plan: EconomicsPlan, overcommit: number, ipsPaise: number, config: PlacementConfig): Row {
  const trial = { ...config, ramOvercommit: overcommit };
  const fit = fitCount(server.node, plan.need, trial);
  const costEach = fit > 0 ? Math.ceil(server.monthlyCostPaise / fit) : null;
  const profits: Row["profits"] = {};
  if (costEach !== null) for (const [key] of PRICES) if (plan.prices[key] !== null) profits[key] = plan.prices[key]! - costEach - ipsPaise;
  return { server, overcommit, fit, heldBy: heldBy(server.node, plan.need, trial), costEach, profits };
}

const signed = (paise: number) => `${paise < 0 ? "-" : "+"}${inr(Math.abs(paise))}`;
const density = (r: Row) => `${r.server.name}${r.server.estimate ? " est." : ""}, RAM \u00d7${r.overcommit}, ${r.fit} per node, ${inr(r.costEach!)} each`;

/** The lowest cost per customer a plan can reach. Guaranteed RAM is never overcommitted, so those rows don't count. */
function bestRow(plan: EconomicsPlan, rows: Row[]): Row | null {
  const sellable = rows.filter((r) => r.costEach !== null && (r.overcommit === 1 || !plan.isDedicated));
  return sellable.reduce<Row | null>((best, r) => (!best || r.costEach! < best.costEach! ? r : best), null);
}

function verdict(plan: EconomicsPlan, rows: Row[]): string {
  const best = bestRow(plan, rows);
  if (!best) return "DOESN'T FIT on any size here";
  const listed = PRICES.filter(([key]) => best.profits[key] !== undefined);
  const losing = listed.filter(([key]) => best.profits[key]! < 0).map(([, label]) => label);
  if (losing.length === 0) return `OK: makes money at every price at its best density (${density(best)})`;
  const where = losing.length === listed.length ? "every price" : losing.join(", ");
  return `LOSES MONEY at ${where}, at its best density (${density(best)})`;
}

/** One plan on every server: with and without overcommit, profit at each price, break-even, and a verdict. */
export function planEconomicsLines(plan: EconomicsPlan, servers: EconomicsServer[], input: EconomicsInput): string[] {
  const { config, overcommit, floatingIpPaise } = input;
  const ipsPaise = plan.ips.count * (floatingIpPaise ?? 0);
  const listed = PRICES.filter(([key]) => plan.prices[key] !== null);
  const promise = plan.ips.stated ? `${plan.ips.count} included` : `${plan.ips.count}: the plan doesn't say, this is what provisioning buys`;
  const gap = plan.ips.stated && plan.ips.count !== FLOATING_IPS_PROVISIONED ? `; provisioning only buys ${FLOATING_IPS_PROVISIONED} today` : "";

  const lines = [
    `${plan.name} \u00b7 ${plan.need.ramMB / 1024} GB, ${plan.need.diskGB} GB \u00b7 ${listed.map(([key, label]) => `${label} ${inr(plan.prices[key]!)}`).join(", ")}`,
    floatingIpPaise === null
      ? `  Floating IPs  ${promise}${gap}; price not available, so NOT counted below`
      : `  Floating IPs  ${promise}${gap}: ${inr(ipsPaise)}/month per customer, counted in the profit below`,
    `  ${"server".padEnd(22)}${"RAM".padEnd(6)}${"fit".padEnd(5)}${"held by".padEnd(22)}${"cost each".padEnd(11)}${listed.map(([, label]) => label.padEnd(14)).join("")}break-even per node`,
  ];

  const rows: Row[] = [];
  for (const server of servers) {
    for (const x of [1, overcommit]) {
      const r = row(server, plan, x, ipsPaise, config);
      rows.push(r);
      const name = `${server.name}${server.estimate ? " est." : ""}`;
      const start = `  ${name.padEnd(22)}${`\u00d7${x}`.padEnd(6)}${String(r.fit).padEnd(5)}${r.heldBy.padEnd(22)}`;
      const guaranteed = x !== 1 && plan.isDedicated ? "  not for sale: this plan's RAM is guaranteed" : "";
      if (r.costEach === null) {
        lines.push(`${start}doesn't fit${guaranteed}`);
        continue;
      }
      const profits = listed.map(([key]) => signed(r.profits[key]!).padEnd(14)).join("");
      const needed = listed.map(([key]) => breakEven(server.monthlyCostPaise, plan.prices[key]!, ipsPaise) ?? "never").join(" / ");
      lines.push(`${start}${inr(r.costEach).padEnd(11)}${profits}${needed}${guaranteed}`);
    }
  }
  return [...lines, `  ${verdict(plan, rows)}`];
}
