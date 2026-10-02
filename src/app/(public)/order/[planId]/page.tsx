import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import OrderClient from "./OrderClient";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;

  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) notFound();

  return (
    <OrderClient
      plan={{
        id: plan.id,
        name: plan.name,
        category: plan.category,
        tier: plan.tier,
        price: plan.price,
        features: plan.features as Record<string, string>,
      }}
    />
  );
}
