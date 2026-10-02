import { prisma } from "@/lib/prisma";
import PricingClient from "./PricingClient";

export const dynamic = "force-dynamic";

async function getPlans() {
  try {
    return await prisma.plan.findMany({
      where: { isActive: true },
      orderBy: [{ category: "asc" }, { price: "asc" }],
    });
  } catch {
    return [];
  }
}

export default async function PricingPage() {
  const plans = await getPlans();
  return <PricingClient plans={plans} />;
}
