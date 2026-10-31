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
] as const;

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

const margin = (paise: number) => (paise < 0 ? `LOSS ${inr(-paise)}` : inr(paise));

/** Node cost per VPS Basic against each price, and the Floating IP on its own line. */
export function unitEconomicsLines(input: { monthlyCostPaise: number; basicFit: number; prices: VpsPrices; floatingIpPaise: number | null }): string[] {
  const { monthlyCostPaise, basicFit, prices, floatingIpPaise } = input;
  if (basicFit === 0) return [`  ${inr(monthlyCostPaise)}/month, and no VPS Basic fits, so there's no cost per container`];
  const perContainer = Math.ceil(monthlyCostPaise / basicFit);
  const listed = PRICES.flatMap(([key, label]) => (prices[key] === null ? [] : [{ label, price: prices[key]! }]));
  const lines = [
    `  ${inr(monthlyCostPaise)}/month \u00f7 ${basicFit} VPS Basic = ${inr(perContainer)} per container`,
    ...listed.map(({ label, price }) => `  ${label.padEnd(13)} ${inr(price).padEnd(9)} leaves ${margin(price - perContainer)}`),
  ];
  if (floatingIpPaise === null) return [...lines, "  Floating IP   price not available"];
  const after = listed.map(({ label, price }) => `${label} ${margin(price - perContainer - floatingIpPaise)}`).join(", ");
  return [...lines, `  Floating IP   ${inr(floatingIpPaise)}/month per container, on top. After it: ${after}`];
}
