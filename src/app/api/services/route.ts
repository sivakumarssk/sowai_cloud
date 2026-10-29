import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import { withDecryptedCredentials } from "@/lib/crypto";
import { forCustomer } from "@/lib/provisioning/serverReady";

export async function GET() {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const services = await prisma.service.findMany({
    where: { userId: session.userId },
    include: {
      plan: true,
      // Current autopay (newest subscription) for the billing panel.
      subscriptions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          status: true,
          billingCycle: true,
          amount: true,
          gstAmount: true,
          processingFee: true,
          chargeAt: true,
          currentEnd: true,
        },
      },
      // Terms the service was bought on (cycle, first-term price, addons).
      order: {
        select: {
          billingCycle: true,
          amount: true,
          gstAmount: true,
          processingFee: true,
          isIntroPrice: true,
          renewalAmount: true,
          addons: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // IP and credentials only for real servers; anything else shows as "Setting up".
  return apiSuccess(services.map((s) => forCustomer(withDecryptedCredentials(s))));
}
