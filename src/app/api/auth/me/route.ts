import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return apiError("Unauthorized", 401);

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        company: true,
        role: true,
        isVerified: true,
        createdAt: true,
      },
    });

    if (!user) return apiError("User not found", 404);

    return apiSuccess({ user });
  } catch (err) {
    console.error("[me]", err);
    return apiError("Internal server error", 500);
  }
}
