import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import { withDecryptedCredentials } from "@/lib/crypto";

export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return apiError("Forbidden", 403);

  const services = await prisma.service.findMany({
    include: {
      user: { select: { name: true, email: true } },
      plan: { select: { name: true, category: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return apiSuccess(services.map(withDecryptedCredentials));
}
