import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { findActivePlan, addonsForPlan, isReturningCustomer, toPublicPlan } from "@/lib/plans";
import { availableCycles, isCycleKey, resolveAddons } from "@/lib/pricing";
import OrderClient from "./OrderClient";

export const dynamic = "force-dynamic";

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ cycle?: string; addons?: string }>;
}) {
  const [{ planId }, { cycle, addons: addonParam }] = await Promise.all([params, searchParams]);

  const plan = await findActivePlan(planId);
  if (!plan) notFound();

  const publicPlan = toPublicPlan(plan);
  const cycles = availableCycles(publicPlan);
  if (cycles.length === 0) notFound();
  const initialCycle =
    isCycleKey(cycle) && cycles.includes(cycle) ? cycle : cycles.includes("1year") ? "1year" : cycles[0];

  const session = await getSession();
  const [addons, returning] = await Promise.all([
    addonsForPlan(plan),
    session ? isReturningCustomer(session.userId, plan.id) : Promise.resolve(false),
  ]);

  // Addons come back in the URL when the user returns from the configure step.
  const initialAddons = resolveAddons(addons, (addonParam ?? "").split(","), plan.category).map((a) => a.slug);

  return (
    <OrderClient
      plan={publicPlan}
      addons={addons}
      initialCycle={initialCycle}
      initialAddons={initialAddons}
      returning={returning}
    />
  );
}
