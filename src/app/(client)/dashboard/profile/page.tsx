"use client";

import { useState, useEffect, useTransition } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { showToast } from "@/components/ui/Toast";
import { useAuthStore } from "@/store/authStore";

export default function ProfilePage() {
  const { user, setAuth, token } = useAuthStore();
  const [form, setForm] = useState({
    name: "",
    phone: "",
    company: "",
  });
  const [passwords, setPasswords] = useState({
    current: "",
    new: "",
    confirm: "",
  });
  const [isPending, startTransition] = useTransition();
  const [isPasswordPending, startPasswordTransition] = useTransition();

  useEffect(() => {
    if (user) {
      setForm({ name: user.name, phone: user.phone, company: user.company || "" });
    }
  }, [user]);

  function updateProfile(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await fetch("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (res.ok) {
        if (user && token) {
          setAuth({ ...user, ...data.data }, token);
        }
        showToast("Profile updated successfully!", "success");
      } else {
        showToast(data.error || "Update failed", "error");
      }
    });
  }

  function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (passwords.new !== passwords.confirm) {
      showToast("New passwords don't match", "error");
      return;
    }
    if (passwords.new.length < 8) {
      showToast("Password must be at least 8 characters", "error");
      return;
    }

    startPasswordTransition(async () => {
      const res = await fetch("/api/user/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: passwords.current, newPassword: passwords.new }),
      });
      const data = await res.json();
      if (res.ok) {
        setPasswords({ current: "", new: "", confirm: "" });
        showToast("Password changed successfully!", "success");
      } else {
        showToast(data.error || "Password change failed", "error");
      }
    });
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Profile Settings</h1>
        <p className="text-gray-500 text-sm mt-1">Manage your account details</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Profile info */}
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6">
          <h2 className="text-white font-semibold mb-5">Personal Information</h2>
          <form onSubmit={updateProfile} className="flex flex-col gap-4">
            <Input
              label="Full name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <Input
              label="Email address"
              type="email"
              value={user?.email || ""}
              disabled
              hint="Email cannot be changed"
            />
            <Input
              label="Mobile number"
              type="tel"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            />
            <Input
              label="Company name (optional)"
              value={form.company}
              onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
            />
            <Button type="submit" loading={isPending} className="w-full mt-2">
              Save Changes
            </Button>
          </form>
        </div>

        {/* Password */}
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6">
          <h2 className="text-white font-semibold mb-5">Change Password</h2>
          <form onSubmit={changePassword} className="flex flex-col gap-4">
            <Input
              label="Current password"
              type="password"
              placeholder="Your current password"
              value={passwords.current}
              onChange={(e) => setPasswords((p) => ({ ...p, current: e.target.value }))}
            />
            <Input
              label="New password"
              type="password"
              placeholder="Min. 8 characters"
              value={passwords.new}
              onChange={(e) => setPasswords((p) => ({ ...p, new: e.target.value }))}
            />
            <Input
              label="Confirm new password"
              type="password"
              placeholder="Repeat new password"
              value={passwords.confirm}
              onChange={(e) => setPasswords((p) => ({ ...p, confirm: e.target.value }))}
            />
            <Button type="submit" loading={isPasswordPending} className="w-full mt-2">
              Change Password
            </Button>
          </form>
        </div>

        {/* Account info */}
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6 lg:col-span-2">
          <h2 className="text-white font-semibold mb-4">Account Details</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-gray-500 text-xs mb-1">Account Type</p>
              <p className="text-white text-sm font-medium">{user?.role === "ADMIN" ? "Administrator" : "Client"}</p>
            </div>
            <div>
              <p className="text-gray-500 text-xs mb-1">Member Since</p>
              <p className="text-white text-sm font-medium">
                {new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" })}
              </p>
            </div>
            <div>
              <p className="text-gray-500 text-xs mb-1">Email Status</p>
              <p className="text-sm font-medium text-amber-400">Pending verification</p>
            </div>
            <div>
              <p className="text-gray-500 text-xs mb-1">2FA</p>
              <p className="text-gray-500 text-sm">Not enabled</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
