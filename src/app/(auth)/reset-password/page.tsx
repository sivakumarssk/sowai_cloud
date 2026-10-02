"use client";

import { useState, useTransition, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { showToast } from "@/components/ui/Toast";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  if (!token) {
    return (
      <div className="w-full max-w-md">
        <div className="bg-[#111827] border border-red-900/50 rounded-2xl p-8 text-center">
          <p className="text-red-400">Invalid reset link. Please request a new one.</p>
          <Link href="/forgot-password">
            <Button variant="secondary" className="mt-4 w-full">Request new link</Button>
          </Link>
        </div>
      </div>
    );
  }

  function validate() {
    const e: Record<string, string> = {};
    if (password.length < 8) e.password = "At least 8 characters";
    if (password !== confirmPassword) e.confirmPassword = "Passwords do not match";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    startTransition(async () => {
      try {
        const res = await fetch("/api/auth/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, password }),
        });
        const data = await res.json();
        if (res.ok) {
          showToast("Password reset successfully!", "success");
          router.push("/login");
        } else {
          showToast(data.error || "Reset failed", "error");
        }
      } catch {
        showToast("Network error. Please try again.", "error");
      }
    });
  }

  return (
    <div className="w-full max-w-md">
      <div className="bg-[#111827] border border-[#1F2937] rounded-2xl p-8 shadow-2xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white">Set new password</h1>
          <p className="text-gray-400 mt-1 text-sm">
            Choose a strong password for your account
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <Input
            label="New password"
            type="password"
            placeholder="Min. 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password}
          />

          <Input
            label="Confirm new password"
            type="password"
            placeholder="Repeat password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            error={errors.confirmPassword}
          />

          <Button type="submit" loading={isPending} size="lg" className="w-full">
            Reset password
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="w-full max-w-md h-80 bg-[#111827] rounded-2xl animate-pulse" />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
