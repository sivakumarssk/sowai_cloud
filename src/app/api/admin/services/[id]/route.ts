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
  const { serverIp, sshUsername, sshPassword, panelUrl, status } = await req.json();

  const service = await prisma.service.update({
    where: { id },
    data: {
      ...(serverIp !== undefined && { serverIp }),
      ...(sshUsername !== undefined && { sshUsername }),
      ...(sshPassword !== undefined && { sshPassword }),
      ...(panelUrl !== undefined && { panelUrl }),
      ...(status !== undefined && { status }),
    },
    include: {
      user: { select: { name: true, email: true } },
      plan: { select: { name: true, category: true } },
    },
  });

  return apiSuccess(service);
}
