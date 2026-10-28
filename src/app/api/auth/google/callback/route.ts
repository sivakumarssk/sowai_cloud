import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { signToken, AUTH_COOKIE_OPTIONS } from "@/lib/auth";
import { GOOGLE_STATE_COOKIE, safeRedirectPath } from "@/lib/googleOAuth";

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

  // state is "<nonce>:<redirect path>"; the nonce must match the cookie set by /api/auth/google.
  const sep = state?.indexOf(":") ?? -1;
  const nonce = state && sep > 0 ? state.slice(0, sep) : null;
  const redirect = safeRedirectPath(state && sep > 0 ? state.slice(sep + 1) : null);
  const expectedNonce = req.cookies.get(GOOGLE_STATE_COOKIE)?.value;

  const fail = (reason: string) => {
    const res = NextResponse.redirect(new URL(`/login?error=${reason}`, appUrl));
    res.cookies.delete({ name: GOOGLE_STATE_COOKIE, path: "/api/auth/google" });
    return res;
  };

  if (error || !code) {
    if (error) console.error("[google-callback] Google returned error:", error);
    return fail("google_denied");
  }
  if (!nonce || !expectedNonce || nonce !== expectedNonce) {
    console.error("[google-callback] state mismatch (cookie missing or expired)");
    return fail("google_state");
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

    const tokens: GoogleTokenResponse & { error_description?: string } = await tokenRes.json();
    if (tokens.error || !tokens.access_token) {
      // e.g. invalid_client (wrong secret) or redirect_uri_mismatch (NEXT_PUBLIC_APP_URL ≠ the URL used to start login)
      console.error("[google-callback] token exchange failed:", tokens.error, tokens.error_description);
      return fail("google_token_failed");
    }

    // Get user info
    const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const googleUser: GoogleUserInfo = await userRes.json();

    if (!googleUser.email || !googleUser.email_verified) {
      return fail("google_email_unverified");
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

    // Set on the redirect itself so the session survives the redirect.
    response.cookies.set("auth_token", token, AUTH_COOKIE_OPTIONS);
    response.cookies.delete({ name: GOOGLE_STATE_COOKIE, path: "/api/auth/google" });

    return response;
  } catch (err) {
    console.error("[google-callback]", err);
    return fail("google_failed");
  }
}
