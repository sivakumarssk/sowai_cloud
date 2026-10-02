import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import ConfigureClient from "./ConfigureClient";

export const dynamic = "force-dynamic";

export default async function ConfigurePage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;

  const session = await getSession();
  if (!session) {
    redirect(`/login?redirect=${encodeURIComponent(`/order/${planId}/configure`)}`);
  }

  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) notFound();

  return (
    <ConfigureClient
      plan={{
        id: plan.id,
        name: plan.name,
        category: plan.category,
        tier: plan.tier,
        price: plan.price,
      }}
    />
  );
}
