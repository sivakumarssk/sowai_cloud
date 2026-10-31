import { prisma } from "@/lib/prisma";
import { toPublicPlans } from "@/lib/plans";
import PricingClient from "./PricingClient";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "VPS Pricing — Sowsi Cloud",
  description:
    "Linux VPS plans with sudo SSH access, NVMe SSD and a dedicated IPv4. Prices in INR, pay by UPI, card or netbanking.",
};

export const dynamic = "force-dynamic";

async function getPlans() {
  try {
    const plans = await prisma.plan.findMany({
      where: { isActive: true, category: { in: ["VPS", "STORAGE"] } },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    });
    return await toPublicPlans(plans);
  } catch {
    return [];
  }
}

export default async function PricingPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const [plans, { tab }] = await Promise.all([getPlans(), searchParams]);
  // Object storage tab is hidden for now, so ?tab=storage falls back to VPS.
  // const initialTab = tab === "storage" ? "STORAGE" : tab === "dedicated" ? "DEDICATED" : "VPS";
  const initialTab = tab === "dedicated" ? "DEDICATED" : "VPS";
  return <PricingClient plans={plans} initialTab={initialTab} />;
}
