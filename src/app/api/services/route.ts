import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import { withDecryptedCredentials } from "@/lib/crypto";

export async function GET() {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const services = await prisma.service.findMany({
    where: { userId: session.userId },
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });

  return apiSuccess(services.map(withDecryptedCredentials));
}
