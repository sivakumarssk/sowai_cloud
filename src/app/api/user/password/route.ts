import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { currentPassword, newPassword } = await req.json();
  if (!currentPassword || !newPassword) return apiError("Both passwords are required");
  if (newPassword.length < 8) return apiError("New password must be at least 8 characters");

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) return apiError("User not found", 404);

  const match = await bcrypt.compare(currentPassword, user.password);
  if (!match) return apiError("Current password is incorrect", 401);

  const hashed = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { password: hashed } });

  return apiSuccess({ message: "Password changed successfully" });
}
