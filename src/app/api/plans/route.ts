import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";

export const dynamic = "force-static";

export async function GET() {
  try {
    const plans = await prisma.plan.findMany({
      where: { isActive: true },
      orderBy: [{ category: "asc" }, { price: "asc" }],
    });
    return apiSuccess(plans);
  } catch {
    return apiError("Failed to fetch plans", 500);
  }
}
