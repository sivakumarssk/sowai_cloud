import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import { cancelAutopayForService, latestSubscription, TERMINAL_STATUSES } from "@/lib/billing/subscriptions";

/**
 * Stops autopay. Nothing more is charged; the server keeps running until the
 * end of the period already paid for, then the billing job suspends it.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { id } = await params;
  const service = await prisma.service.findUnique({ where: { id }, include: { plan: true } });
  if (!service || service.userId !== session.userId) return apiError("Service not found", 404);

  const latest = await latestSubscription(service.id);
  if (!latest || TERMINAL_STATUSES.includes(latest.status)) return apiError("Autopay isn't active for this server", 409);

  try {
    await cancelAutopayForService(service.id);
  } catch (err) {
    console.error("[autopay-cancel]", err);
    return apiError("Couldn't cancel autopay right now. Please try again or contact support.", 502);
  }

  const paidUntil = service.nextBillingDate.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  await prisma.notification
    .create({
      data: {
        userId: service.userId,
        title: "Autopay cancelled",
        message: `Autopay for your ${service.plan.name} server is off. It keeps running until ${paidUntil}.`,
      },
    })
    .catch(console.error);

  return apiSuccess({ paidUntil: service.nextBillingDate });
}
