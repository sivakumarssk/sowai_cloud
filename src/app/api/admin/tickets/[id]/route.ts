import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return apiError("Forbidden", 403);

  const { id } = await params;
  const { status, priority } = await req.json();

  const ticket = await prisma.ticket.update({
    where: { id },
    data: {
      ...(status && { status }),
      ...(priority && { priority }),
    },
    include: { user: { select: { name: true, email: true } } },
  });

  return apiSuccess(ticket);
}
