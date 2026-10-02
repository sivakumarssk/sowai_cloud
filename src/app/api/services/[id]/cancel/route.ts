import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import { deprovisionVPS, CancelNotAllowedError } from "@/lib/provisioning/provisionVPS";

/** Cancels a service: deletes its VM, releases its Floating IP and marks it DELETED. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { id } = await params;
  const service = await prisma.service.findUnique({ where: { id }, select: { userId: true } });
  if (!service || (service.userId !== session.userId && session.role !== "ADMIN")) {
    return apiError("Service not found", 404);
  }

  try {
    await deprovisionVPS(id);
  } catch (err) {
    if (err instanceof CancelNotAllowedError) return apiError(err.message, 409);
    console.error("[cancel-service]", err);
    return apiError("We couldn't finish deleting your server. Our team has been notified and will complete it.", 502);
  }

  return apiSuccess({ status: "DELETED" });
}
