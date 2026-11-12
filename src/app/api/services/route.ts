import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import { withDecryptedCredentials } from "@/lib/crypto";
import { forCustomer } from "@/lib/provisioning/serverReady";
import { serviceConnection } from "@/lib/provisioning/connection";

export async function GET() {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const services = await prisma.service.findMany({
    where: { userId: session.userId },
    include: {
      plan: true,
      // The shared IPv4, for a shared-mode service.
      node: { select: { gatewayIpv4: true } },
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
  return apiSuccess(
    services.map((s) => {
      const shown = forCustomer(withDecryptedCredentials(s));
      // Only what the customer needs: not the node's other fields, the private address or the route key.
      const sent: Partial<typeof shown> = { ...shown };
      delete sent.node;
      delete sent.privateIpv4;
      delete sent.routeKey;
      return { ...sent, connection: shown.ready ? serviceConnection(shown) : null };
    })
  );
}
