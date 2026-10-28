import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { GOOGLE_STATE_COOKIE, safeRedirectPath } from "@/lib/googleOAuth";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const redirect = safeRedirectPath(searchParams.get("redirect"));

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  if (!clientId || clientId === "your_google_client_id" || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error("[google-oauth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set");
    return NextResponse.redirect(
      new URL(`/login?error=google_not_configured`, appUrl)
    );
  }

  const callbackUrl = `${appUrl}/api/auth/google/callback`;
  // Random nonce echoed back by Google and checked against a cookie, so a
  // forged callback can't log the visitor into someone else's account.
  const nonce = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
    state: `${nonce}:${redirect}`,
  });

  const response = NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  );
  response.cookies.set(GOOGLE_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/api/auth/google",
  });
  return response;
}
