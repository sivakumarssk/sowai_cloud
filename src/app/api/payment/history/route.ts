import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";

export async function GET() {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const payments = await prisma.payment.findMany({
    where: { userId: session.userId },
    include: { service: { include: { plan: { select: { name: true } } } } },
    orderBy: { createdAt: "desc" },
  });

  return apiSuccess(payments);
}
