"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useAuthStore } from "@/store/authStore";
import { Button } from "@/components/ui/Button";
import { useRouter } from "next/navigation";
import sowsiLogo from "@/assets/sowsi-logo.png";

const navLinks = [
  { href: "/pricing", label: "Pricing" },
  { href: "/hosting", label: "Hosting by Stack" },
  { href: "/#features", label: "Features" },
  { href: "/#why-us", label: "Why Us" },
  { href: "/#testimonials", label: "Reviews" },
];

export default function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const [mobileOpen, setMobileOpen] = useState(false);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    clearAuth();
    router.push("/");
  }

  return (
    <nav
      className="sticky top-0 z-50 bg-surface border-b border-line shadow-lg shadow-black/30"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">

          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5 shrink-0">
            <Image src={sowsiLogo} alt="Sowsi Cloud" className="h-8 w-auto shrink-0" priority />
            <div className="flex flex-col">
              <span className="font-bold text-fg text-base leading-tight">Cloud</span>
            </div>
          </Link>

          {/* Desktop Nav Links */}
          <div className="hidden md:flex items-center gap-1">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-150 ${
                  pathname === link.href
                    ? "text-link bg-primary/15"
                    : "text-fg-muted hover:text-fg hover:bg-surface-2"
                }`}
              >
                {link.label}
              </Link>
            ))}
          </div>

          {/* Auth Buttons */}
          <div className="hidden md:flex items-center gap-3">
            {user ? (
              <>
                <Link href={user.role === "ADMIN" ? "/admin" : "/dashboard"}>
                  <Button variant="secondary" size="sm">
                    {user.role === "ADMIN" ? "Admin Panel" : "Dashboard"}
                  </Button>
                </Link>
                <Button variant="ghost" size="sm" onClick={handleLogout}>
                  Sign out
                </Button>
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  className="inline-flex items-center h-8 px-3 text-sm font-medium rounded-lg text-fg-muted hover:text-fg hover:bg-surface-2 transition-colors duration-150"
                >
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className="inline-flex items-center h-8 px-3 text-sm font-semibold rounded-lg bg-primary text-on-primary hover:bg-primary-hover active:bg-primary-active transition-colors duration-150"
                >
                  Get Started
                </Link>
              </>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            className="md:hidden p-2 rounded-lg text-fg-muted hover:text-fg hover:bg-surface-2 transition-colors duration-150"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>

        {/* Mobile menu */}
        {mobileOpen && (
          <div className="md:hidden border-t border-line py-4 flex flex-col gap-1">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="block px-4 py-2.5 text-sm text-fg-muted hover:text-fg hover:bg-surface-2 rounded-lg transition-colors duration-150"
                onClick={() => setMobileOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            <div className="flex flex-col gap-2 mt-3 pt-3 border-t border-line">
              {user ? (
                <>
                  <Link
                    href={user.role === "ADMIN" ? "/admin" : "/dashboard"}
                    onClick={() => setMobileOpen(false)}
                    className="w-full px-4 py-2.5 text-center text-sm font-medium text-fg border border-line-strong rounded-lg hover:border-fg-subtle hover:bg-surface-2 transition-colors duration-150"
                  >
                    {user.role === "ADMIN" ? "Admin Panel" : "Dashboard"}
                  </Link>
                  <button
                    onClick={handleLogout}
                    className="w-full px-4 py-2.5 text-sm font-medium text-fg-muted hover:text-fg rounded-lg transition-colors duration-150"
                  >
                    Sign out
                  </button>
                </>
              ) : (
                <>
                  <Link
                    href="/login"
                    onClick={() => setMobileOpen(false)}
                    className="w-full px-4 py-2.5 text-center text-sm font-medium text-fg border border-line-strong rounded-lg hover:border-fg-subtle hover:bg-surface-2 transition-colors duration-150"
                  >
                    Sign in
                  </Link>
                  <Link
                    href="/signup"
                    onClick={() => setMobileOpen(false)}
                    className="w-full px-4 py-2.5 text-center text-sm font-semibold text-on-primary bg-primary rounded-lg hover:bg-primary-hover active:bg-primary-active transition-colors duration-150"
                  >
                    Get Started
                  </Link>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
