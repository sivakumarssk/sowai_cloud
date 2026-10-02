import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { signToken, setAuthCookie } from "@/lib/auth";

interface GoogleTokenResponse {
  access_token: string;
  id_token: string;
  error?: string;
}

interface GoogleUserInfo {
  sub: string;
  email: string;
  name: string;
  picture: string;
  email_verified: boolean;
}

export async function GET(req: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const redirect = state ? decodeURIComponent(state) : "/dashboard";

  if (error || !code) {
    return NextResponse.redirect(new URL(`/login?error=google_denied`, appUrl));
  }

  try {
    const callbackUrl = `${appUrl}/api/auth/google/callback`;

    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: callbackUrl,
        grant_type: "authorization_code",
      }),
    });

    const tokens: GoogleTokenResponse = await tokenRes.json();
    if (tokens.error || !tokens.access_token) {
      return NextResponse.redirect(new URL(`/login?error=google_token_failed`, appUrl));
    }

    // Get user info
    const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const googleUser: GoogleUserInfo = await userRes.json();

    if (!googleUser.email || !googleUser.email_verified) {
      return NextResponse.redirect(new URL(`/login?error=google_email_unverified`, appUrl));
    }

    // Upsert user — find by email, create if new
    let user = await prisma.user.findUnique({ where: { email: googleUser.email } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: googleUser.email,
          name: googleUser.name || googleUser.email.split("@")[0],
          // Google users get a placeholder password they can never use (no plain-text stored)
          password: `google_oauth_${googleUser.sub}`,
          phone: "0000000000",
          isVerified: true,
          role: "CLIENT",
        },
      });
    } else {
      // Mark existing user as verified if they sign in via Google
      if (!user.isVerified) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { isVerified: true },
        });
      }
    }

    const token = await signToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    });

    const response = NextResponse.redirect(
      new URL(user.role === "ADMIN" ? "/admin" : redirect, appUrl)
    );

    await setAuthCookie(token);

    return response;
  } catch (err) {
    console.error("[google-callback]", err);
    return NextResponse.redirect(new URL(`/login?error=google_failed`, appUrl));
  }
}
