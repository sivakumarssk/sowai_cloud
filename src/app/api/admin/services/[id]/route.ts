import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import { encrypt, withDecryptedCredentials } from "@/lib/crypto";

const serviceInclude = {
  user: { select: { name: true, email: true } },
  plan: { select: { name: true, category: true } },
} as const;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return apiError("Forbidden", 403);

  const { id } = await params;
  const service = await prisma.service.findUnique({ where: { id }, include: serviceInclude });
  if (!service) return apiError("Service not found", 404);

  return apiSuccess(withDecryptedCredentials(service));
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return apiError("Forbidden", 403);

  const { id } = await params;
  const { serverIp, sshUsername, sshPassword, panelUrl, panelPassword, status } = await req.json();

  const service = await prisma.service.update({
    where: { id },
    data: {
      ...(serverIp !== undefined && { serverIp }),
      ...(sshUsername !== undefined && { sshUsername }),
      ...(sshPassword !== undefined && { sshPassword: sshPassword ? encrypt(sshPassword) : null }),
      ...(panelUrl !== undefined && { panelUrl }),
      ...(panelPassword !== undefined && { panelPassword: panelPassword ? encrypt(panelPassword) : null }),
      ...(status !== undefined && { status }),
    },
    include: serviceInclude,
  });

  return apiSuccess(withDecryptedCredentials(service));
}
