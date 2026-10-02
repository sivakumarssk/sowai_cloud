import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { id } = await params;

  const order = await prisma.order.findUnique({
    where: { id },
    include: { service: true },
  });

  if (!order || order.userId !== session.userId) {
    return apiError("Order not found", 404);
  }

  return apiSuccess({
    orderStatus: order.status,
    service: order.service
      ? {
          id: order.service.id,
          status: order.service.status,
          serverIp: order.service.serverIp,
          hostname: order.service.hostname,
          panelUrl: order.service.panelUrl,
          provisionError: order.service.provisionError,
        }
      : null,
  });
}
