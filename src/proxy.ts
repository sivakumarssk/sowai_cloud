import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const secret = new TextEncoder().encode(
  process.env.JWT_SECRET || "fallback-secret-change-in-production"
);

const AUTH_PATHS = ["/login", "/signup"];
const CLIENT_PATHS = ["/dashboard"];
const ADMIN_PATHS = ["/admin"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const token = req.cookies.get("auth_token")?.value;

  let payload: { userId?: string; role?: string } | null = null;
  if (token) {
    try {
      const { payload: p } = await jwtVerify(token, secret);
      payload = p as { userId: string; role: string };
    } catch {
      payload = null;
    }
  }

  const isAuthenticated = !!payload;
  const isAdmin = payload?.role === "ADMIN";

  // Redirect authenticated users away from auth pages
  if (isAuthenticated && AUTH_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  // Protect client dashboard routes
  if (CLIENT_PATHS.some((p) => pathname.startsWith(p))) {
    if (!isAuthenticated) {
      const loginUrl = new URL("/login", req.url);
      loginUrl.searchParams.set("redirect", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  // Protect admin routes — require ADMIN role
  if (ADMIN_PATHS.some((p) => pathname.startsWith(p))) {
    if (!isAuthenticated) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
    if (!isAdmin) {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
  }

  // Protect API routes (non-auth)
  if (pathname.startsWith("/api/") && !pathname.startsWith("/api/auth/")) {
    // Razorpay calls this server-to-server with no cookie — it authenticates
    // itself via the X-Razorpay-Signature header, verified inside the route.
    if (pathname === "/api/payment/webhook") {
      return NextResponse.next();
    }

    if (pathname.startsWith("/api/admin/") && !isAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const clientProtected =
      pathname.startsWith("/api/payment/") ||
      pathname.startsWith("/api/services") ||
      pathname.startsWith("/api/tickets") ||
      pathname.startsWith("/api/user/") ||
      pathname.startsWith("/api/orders/");

    if (clientProtected && !isAuthenticated) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|public/).*)"],
};
