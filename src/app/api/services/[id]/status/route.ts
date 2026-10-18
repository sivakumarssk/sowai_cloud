import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";

/** Live provisioning progress for the progress page (polled every few seconds). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { id } = await params;
  const service = await prisma.service.findUnique({
    where: { id },
    select: {
      userId: true,
      status: true,
      provisioningStep: true,
      provisioningPct: true,
      serverIp: true,
      ipv6Address: true,
    },
  });
  if (!service || (service.userId !== session.userId && session.role !== "ADMIN")) {
    return apiError("Service not found", 404);
  }

  const active = service.status === "ACTIVE";
  return apiSuccess({
    status: service.status,
    provisioningStep: service.provisioningStep,
    provisioningPct: service.provisioningPct,
    serverIp: active ? service.serverIp : null,
    ipv6Address: active ? service.ipv6Address : null,
  });
}
