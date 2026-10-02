"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

export default function SignupPage() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    company: "",
    password: "",
    confirmPassword: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();
  const [googleLoading, setGoogleLoading] = useState(false);

  function set(field: string, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: "" }));
  }

  function validate() {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = "Full name is required";
    if (!form.email) e.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "Invalid email";
    if (!form.phone) e.phone = "Phone is required";
    else if (!/^[6-9]\d{9}$/.test(form.phone)) e.phone = "Enter a valid 10-digit Indian mobile number";
    if (!form.password) e.password = "Password is required";
    else if (form.password.length < 8) e.password = "At least 8 characters";
    if (form.password !== form.confirmPassword) e.confirmPassword = "Passwords do not match";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    startTransition(async () => {
      try {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name,
            email: form.email,
            phone: form.phone,
            company: form.company || undefined,
            password: form.password,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || "Registration failed", "error");
          return;
        }
        setAuth(data.data.user, data.data.token);
        showToast("Account created successfully!", "success");
        router.push("/dashboard");
      } catch {
        showToast("Network error. Please try again.", "error");
      }
    });
  }

  function handleGoogleSignup() {
    setGoogleLoading(true);
    window.location.href = "/api/auth/google?redirect=/dashboard";
  }

  return (
    <div className="w-full max-w-md">
      <div className="bg-[#111827] border border-[#1F2937] rounded-2xl p-8 shadow-2xl">
        <div className="mb-7">
          <h1 className="text-2xl font-bold text-white">Create your account</h1>
          <p className="text-gray-400 mt-1 text-sm">Start hosting with Sowsi Cloud today</p>
        </div>

        {/* Google OAuth */}
        <button
          onClick={handleGoogleSignup}
          disabled={googleLoading || isPending}
          className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-lg border border-[#374151] bg-[#0A0F1E] hover:bg-white/5 hover:border-[#4B5563] text-white text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed mb-5"
        >
          {googleLoading ? (
            <svg className="animate-spin h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : <GoogleIcon />}
          Sign up with Google
        </button>

        {/* Divider */}
        <div className="flex items-center gap-3 mb-5">
          <div className="flex-1 h-px bg-[#1F2937]" />
          <span className="text-gray-600 text-xs">or sign up with email</span>
          <div className="flex-1 h-px bg-[#1F2937]" />
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Full name"
              type="text"
              placeholder="Ravi Kumar"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              error={errors.name}
              autoComplete="name"
            />
            <Input
              label="Mobile number"
              type="tel"
              placeholder="9876543210"
              value={form.phone}
              onChange={(e) => set("phone", e.target.value)}
              error={errors.phone}
              autoComplete="tel"
            />
          </div>

          <Input
            label="Email address"
            type="email"
            placeholder="you@example.com"
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
            error={errors.email}
            autoComplete="email"
          />

          <Input
            label="Company name (optional)"
            type="text"
            placeholder="Your Company Pvt. Ltd."
            value={form.company}
            onChange={(e) => set("company", e.target.value)}
            autoComplete="organization"
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Password"
              type="password"
              placeholder="Min. 8 chars"
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
              error={errors.password}
              autoComplete="new-password"
            />
            <Input
              label="Confirm password"
              type="password"
              placeholder="Repeat password"
              value={form.confirmPassword}
              onChange={(e) => set("confirmPassword", e.target.value)}
              error={errors.confirmPassword}
              autoComplete="new-password"
            />
          </div>

          <p className="text-xs text-gray-500">
            By creating an account you agree to our{" "}
            <Link href="/terms" className="text-[#1B4FE8] hover:underline">Terms of Service</Link>
            {" "}and{" "}
            <Link href="/privacy" className="text-[#1B4FE8] hover:underline">Privacy Policy</Link>.
          </p>

          <Button type="submit" loading={isPending} size="lg" className="w-full">
            Create account
          </Button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-gray-500 text-sm">
            Already have an account?{" "}
            <Link href="/login" className="text-[#1B4FE8] hover:text-[#0EA5E9] font-medium transition-colors">
              Sign in
            </Link>
          </p>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-center gap-6">
        {[
          { icon: "🧾", label: "GST Invoice" },
          { icon: "🇮🇳", label: "Indian Servers" },
          { icon: "⚡", label: "Instant Setup" },
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
