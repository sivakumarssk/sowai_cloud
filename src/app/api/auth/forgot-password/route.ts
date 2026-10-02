import { NextRequest } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { sendPasswordResetEmail } from "@/lib/email";
import { apiSuccess, apiError } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();

    if (!email) return apiError("Email is required");

    const user = await prisma.user.findUnique({ where: { email } });

    // Always return success to prevent email enumeration
    if (!user) {
      return apiSuccess({
        message: "If that email exists, a reset link has been sent.",
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken: token, resetTokenExp: expiry },
    });

    sendPasswordResetEmail(user.email, user.name, token).catch(console.error);

    return apiSuccess({
      message: "If that email exists, a reset link has been sent.",
    });
  } catch (err) {
    console.error("[forgot-password]", err);
    return apiError("Internal server error", 500);
  }
}
