import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { findActivePlan, addonsForPlan, isReturningCustomer, toPublicPlan, availabilityChecker } from "@/lib/plans";
import { availableCycles, isCycleKey, resolveAddons } from "@/lib/pricing";
import { DEFAULT_OS, getOsImage, getPresetsForCategory } from "@/lib/provisioning/catalog";
import ConfigureClient from "./ConfigureClient";

export const dynamic = "force-dynamic";

export default async function ConfigurePage({
  params,
  searchParams,
}: {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ cycle?: string; addons?: string; hostname?: string; stack?: string; os?: string }>;
}) {
  const [{ planId }, query] = await Promise.all([params, searchParams]);

  const session = await getSession();
  if (!session) {
    const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => !!e[1])).toString();
    redirect(`/login?redirect=${encodeURIComponent(`/order/${planId}/configure${qs ? `?${qs}` : ""}`)}`);
  }

  const plan = await findActivePlan(planId);
  if (!plan) notFound();

  // Not sold when it can't be built for real (no node can hold it).
  const availability = (await availabilityChecker())(plan);
  if (!availability.orderable) notFound();
  const publicPlan = toPublicPlan(plan, availability);
  const cycles = availableCycles(publicPlan);
  if (cycles.length === 0) notFound();

  // Choices from the plan step (and from earlier visits to this step) arrive in the URL.
  const [addons, returning] = await Promise.all([addonsForPlan(plan), isReturningCustomer(session.userId, plan.id)]);
  const presets = getPresetsForCategory(plan.category);
  const cycle = isCycleKey(query.cycle) && cycles.includes(query.cycle) ? query.cycle : cycles[0];
  const chosenAddons = resolveAddons(addons, (query.addons ?? "").split(","), plan.category).map((a) => a.slug);
  const stack = presets.some((p) => p.value === query.stack) ? query.stack! : presets[0]?.value ?? "plain";
  const os = query.os && getOsImage(query.os) ? query.os : DEFAULT_OS;

  return (
    <ConfigureClient
      plan={publicPlan}
      addons={addons}
      returning={returning}
      cycle={cycle}
      chosenAddonSlugs={chosenAddons}
      initialHostname={query.hostname ?? ""}
      initialStack={stack}
      initialOs={os}
    />
  );
}
