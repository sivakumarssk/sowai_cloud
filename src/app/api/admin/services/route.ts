import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import { withDecryptedCredentials } from "@/lib/crypto";
import { serviceConnection } from "@/lib/provisioning/connection";

export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return apiError("Forbidden", 403);

  const services = await prisma.service.findMany({
    include: {
      user: { select: { name: true, email: true } },
      plan: { select: { name: true, category: true } },
      node: { select: { name: true, gatewayIpv4: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Shared or Dedicated, worded as the customer sees it (src/lib/provisioning/connection.ts).
  return apiSuccess(services.map((s) => ({ ...withDecryptedCredentials(s), connection: serviceConnection(s) })));
}
