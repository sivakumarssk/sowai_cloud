/**
 * Facts read from Hetzner's invoices (USD, VAT 0), as of 2026-11-10. They are for plan text and
 * checks only: nothing is billed or priced from them, and live prices still come from the API.
 */
export const HETZNER_INVOICE = {
  /** Every CPX server includes this much traffic a month... */
  cpxIncludedTrafficTB: 20,
  /** ...then each TB over it costs this. */
  trafficUsdPerTB: 1.2,
  /** A Floating IPv4 is billed by the hour... */
  floatingIpv4UsdHourly: 0.0056,
  /** ...up to this much in a month. */
  floatingIpv4UsdMonthlyMax: 3.5,
} as const;

const TB = 1e12;
const TIB = 2 ** 40;

/** The API gives included traffic in bytes. Whether it means TB or TiB isn't confirmed, so both are shown. */
export function describeIncludedTraffic(bytes: unknown): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return `included traffic: not in the answer (invoice: ${HETZNER_INVOICE.cpxIncludedTrafficTB} TB)`;
  const tb = bytes / TB;
  const tib = bytes / TIB;
  const matches = [tb, tib].some((v) => Math.abs(v - HETZNER_INVOICE.cpxIncludedTrafficTB) < 0.01);
  return `included traffic: ${bytes} bytes = ${tb.toFixed(2)} TB = ${tib.toFixed(2)} TiB${matches ? "" : ` — DIFFERS from the invoice's ${HETZNER_INVOICE.cpxIncludedTrafficTB} TB`}`;
}

/** The API's price per TB over the allowance, against the invoice's. */
export function describeTrafficPrice(gross: unknown): string {
  const price = Number(gross);
  if (gross === undefined || !Number.isFinite(price)) return `traffic over the allowance: not in the answer (invoice: $${HETZNER_INVOICE.trafficUsdPerTB.toFixed(2)}/TB)`;
  return `traffic over the allowance: $${price.toFixed(2)}/TB${Math.abs(price - HETZNER_INVOICE.trafficUsdPerTB) < 0.005 ? "" : ` — DIFFERS from the invoice's $${HETZNER_INVOICE.trafficUsdPerTB.toFixed(2)}/TB`}`;
}

/** The Floating IPv4 line for a plan: billed hourly, capped monthly. */
export function describeFloatingIpv4(apiMonthly: number | null): string {
  const { floatingIpv4UsdHourly: hourly, floatingIpv4UsdMonthlyMax: max } = HETZNER_INVOICE;
  const api = apiMonthly === null ? "the API lists no monthly price" : `the API lists $${apiMonthly.toFixed(2)}/month${Math.abs(apiMonthly - max) < 0.005 ? "" : ` — DIFFERS from the invoice's $${max.toFixed(2)}`}`;
  return `$${hourly}/hour, at most $${max.toFixed(2)}/month (invoice); ${api}`;
}
