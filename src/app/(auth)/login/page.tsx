"use client";

import { useState, useTransition, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { showToast } from "@/components/ui/Toast";
import { useAuthStore } from "@/store/authStore";

function GoogleIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect") || "/dashboard";
  const setAuth = useAuthStore((s) => s.setAuth);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();
  const [googleLoading, setGoogleLoading] = useState(false);

  function validate() {
    const e: Record<string, string> = {};
    if (!email) e.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = "Invalid email";
    if (!password) e.password = "Password is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    startTransition(async () => {
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || "Login failed", "error");
          return;
        }
        setAuth(data.data.user, data.data.token);
        showToast("Welcome back!", "success");
        router.push(data.data.user.role === "ADMIN" ? "/admin" : redirect);
      } catch {
        showToast("Network error. Please try again.", "error");
      }
    });
  }

  function handleGoogleLogin() {
    setGoogleLoading(true);
    window.location.href = `/api/auth/google?redirect=${encodeURIComponent(redirect)}`;
  }

  return (
    <div className="w-full max-w-md">
      <div className="bg-[#111827] border border-[#1F2937] rounded-2xl p-8 shadow-2xl">
        <div className="mb-7">
          <h1 className="text-2xl font-bold text-white">Welcome back</h1>
          <p className="text-gray-400 mt-1 text-sm">Sign in to your Sowsi Cloud account</p>
        </div>

        {/* Google OAuth button */}
        <button
          onClick={handleGoogleLogin}
          disabled={googleLoading || isPending}
          className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-lg border border-[#374151] bg-[#0A0F1E] hover:bg-white/5 hover:border-[#4B5563] text-white text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed mb-5"
        >
          {googleLoading ? (
            <svg className="animate-spin h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : <GoogleIcon />}
          Continue with Google
        </button>

        {/* Divider */}
        <div className="flex items-center gap-3 mb-5">
          <div className="flex-1 h-px bg-[#1F2937]" />
          <span className="text-gray-600 text-xs">or continue with email</span>
          <div className="flex-1 h-px bg-[#1F2937]" />
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Input
            label="Email address"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
            autoComplete="email"
          />

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-gray-300">Password</label>
              <Link href="/forgot-password" className="text-xs text-[#1B4FE8] hover:text-[#0EA5E9] transition-colors">
                Forgot password?
              </Link>
            </div>
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className={`w-full px-4 py-2.5 rounded-lg bg-[#0A0F1E] border text-white placeholder-gray-500 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[#1B4FE8] focus:border-transparent ${errors.password ? "border-red-500" : "border-[#374151] hover:border-[#4B5563]"}`}
            />
            {errors.password && <p className="text-xs text-red-400">{errors.password}</p>}
          </div>

          <Button type="submit" loading={isPending} size="lg" className="w-full mt-1">
            Sign in
          </Button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-gray-500 text-sm">
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="text-[#1B4FE8] hover:text-[#0EA5E9] font-medium transition-colors">
              Create account
            </Link>
          </p>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-center gap-6">
        {[
          { icon: "🔒", label: "SSL Secured" },
          { icon: "🛡️", label: "Trusted & Safe" },
          { icon: "💳", label: "UPI Payments" },
        ].map((b) => (
          <div key={b.label} className="flex items-center gap-1.5 text-gray-600 text-xs">
            <span>{b.icon}</span>
            {b.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="w-full max-w-md h-[480px] bg-[#111827] rounded-2xl animate-pulse" />}>
      <LoginForm />
    </Suspense>
  );
}
