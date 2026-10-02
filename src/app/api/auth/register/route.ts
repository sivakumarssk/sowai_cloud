import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { signToken, setAuthCookie } from "@/lib/auth";
import { sendWelcomeEmail } from "@/lib/email";
import { apiSuccess, apiError } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, email, password, phone, company } = body;

    if (!name || !email || !password || !phone) {
      return apiError("Name, email, phone, and password are required");
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return apiError("Invalid email address");
    }

    if (password.length < 8) {
      return apiError("Password must be at least 8 characters");
    }

    if (!/^[6-9]\d{9}$/.test(phone)) {
      return apiError("Enter a valid 10-digit Indian mobile number");
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return apiError("An account with this email already exists", 409);
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        phone,
        company: company || null,
      },
    });

    const token = await signToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    });

    await setAuthCookie(token);

    // Non-blocking email
    sendWelcomeEmail(user.email, user.name).catch(console.error);

    return apiSuccess({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        company: user.company,
      },
      token,
    });
  } catch (err) {
    console.error("[register]", err);
    return apiError("Internal server error", 500);
  }
}
