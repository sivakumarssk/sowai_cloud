// A customer paid, and minutes later there's still no container: tell an admin.
// Catches anything that leaves a paid order without a real server — the
// simulator, a lost job, a held or waiting order, a crash mid-build.

export const PAID_NO_CONTAINER_AFTER_MS = 10 * 60_000;

export type PaidOrder = { serviceId: string; planName: string; customer: string; status: string; provisioningStep: string | null; paidAt: Date };

export type PaidCheckDeps = {
  /** Services with a successful payment, created before `paidBefore`, not cancelled/deleted/failed, with no container. */
  candidates(paidBefore: Date): Promise<PaidOrder[]>;
  /** Which of these were already alerted (once per service). */
  alreadyAlerted(serviceIds: string[]): Promise<Set<string>>;
  alertAdmin(subject: string, detail: string): Promise<void>;
  record(order: PaidOrder): Promise<void>;
};

export async function alertPaidWithoutContainer(deps: PaidCheckDeps, now = new Date()): Promise<{ alerted: number }> {
  const candidates = await deps.candidates(new Date(now.getTime() - PAID_NO_CONTAINER_AFTER_MS));
  if (candidates.length === 0) return { alerted: 0 };
  const seen = await deps.alreadyAlerted(candidates.map((c) => c.serviceId));
  const fresh = candidates.filter((c) => !seen.has(c.serviceId));
  if (fresh.length === 0) return { alerted: 0 };

  const minutes = (d: Date) => Math.round((now.getTime() - d.getTime()) / 60_000);
  await deps.alertAdmin(
    `${fresh.length} paid order${fresh.length === 1 ? " has" : "s have"} no server after ${PAID_NO_CONTAINER_AFTER_MS / 60_000} minutes`,
    [
      "The payment succeeded but no container exists:",
      ...fresh.map((o) => `  ${o.serviceId}  ${o.planName}  ${o.customer}  ${o.status} — ${o.provisioningStep ?? "no step"} (paid ${minutes(o.paidAt)} min ago)`),
      "",
      "Check: npx tsx scripts/billing/reprovision.ts --service <id>",
    ].join("\n")
  );
  for (const o of fresh) await deps.record(o);
  return { alerted: fresh.length };
}
