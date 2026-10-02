import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { name, phone, company } = await req.json();
  if (!name || !phone) return apiError("Name and phone are required");

  const user = await prisma.user.update({
    where: { id: session.userId },
    data: { name, phone, company: company || null },
    select: { id: true, name: true, email: true, phone: true, company: true, role: true },
  });

  return apiSuccess(user);
}
