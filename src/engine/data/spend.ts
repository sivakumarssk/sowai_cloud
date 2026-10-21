import { prisma } from "@/lib/prisma";

/** EngineLog actions that commit new monthly infrastructure spend. */
export const SPEND_ACTIONS = ["VOLUME_CREATED", "SERVER_PURCHASED"] as const;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Start of the current calendar month in India (IST), as a UTC instant. */
export function istMonthStart(now: Date = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_OFFSET_MS);
}

/**
 * Monthly cost the engine has committed to this IST calendar month, in paise:
 * successful purchases only. Deleting a Volume later doesn't lower it — the
 * cap is about what the engine signed up for, conservatively.
 */
export async function spentThisMonthPaise(now: Date = new Date()): Promise<number> {
  const { _sum } = await prisma.engineLog.aggregate({
    _sum: { cost: true },
    where: { action: { in: [...SPEND_ACTIONS] }, success: true, dryRun: false, createdAt: { gte: istMonthStart(now) } },
  });
  return _sum.cost ?? 0;
}
