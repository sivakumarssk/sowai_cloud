export type BillingCycle = 1 | 12 | 24;

export const BILLING_OPTIONS: { months: BillingCycle; label: string; sublabel: string; discount: number }[] = [
  { months: 1,  label: "Monthly",   sublabel: "Pay month to month",    discount: 0 },
  { months: 12, label: "1 Year",    sublabel: "Billed annually",       discount: 5 },
  { months: 24, label: "2 Years",   sublabel: "Billed every 2 years",  discount: 8 },
];

export const categoryLabel: Record<string, string> = {
  SHARED: "Shared Hosting",
  VPS: "VPS Hosting",
  WORDPRESS: "Managed WordPress",
  STORAGE: "Object Storage",
  DEDICATED: "Dedicated Server",
};

// DB price = 1-year price. Monthly & 2yr prices defined directly.
const MONTHLY_PRICES: Record<number, number> = {
  99: 109,
  199: 219,
  299: 329,
  399: 429,
  599: 649,
  799: 849,
  999: 1049,
  1299: 1349,
  1999: 2099,
  3000: 3199,
  3500: 3699,
  5000: 5249,
};

const TWO_YEAR_PRICES: Record<number, number> = {
  99: 89,
  199: 189,
  299: 279,
  399: 379,
  599: 569,
  799: 749,
  999: 929,
  1299: 1199,
  1999: 1849,
  3000: 2799,
  3500: 3299,
  5000: 4699,
};

export function getFullMonthlyPrice(yearlyPrice: number): number {
  return MONTHLY_PRICES[yearlyPrice] ?? Math.floor(yearlyPrice * 1.05 / 10) * 10 + 9;
}

export function getMonthlyPrice(yearlyPrice: number, months: BillingCycle): number {
  if (months === 1)  return getFullMonthlyPrice(yearlyPrice);
  if (months === 12) return yearlyPrice;
  return TWO_YEAR_PRICES[yearlyPrice] ?? Math.floor(yearlyPrice * 0.94 / 10) * 10 + 9;
}

export function getTotalPrice(yearlyPrice: number, months: BillingCycle): number {
  return getMonthlyPrice(yearlyPrice, months) * months;
}

export function isBillingCycle(value: unknown): value is BillingCycle {
  return value === 1 || value === 12 || value === 24;
}

export function calculateGST(amount: number): number {
  return Math.round(amount * 0.18);
}
