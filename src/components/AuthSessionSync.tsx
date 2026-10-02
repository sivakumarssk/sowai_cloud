"use client";

import { useEffect } from "react";
import { useAuthStore } from "@/store/authStore";

/**
 * Reconciles the persisted (localStorage) auth store with the real
 * httpOnly session cookie on first load. Without this, a stale/expired
 * cookie leaves the UI thinking the user is still logged in (Navbar shows
 * Dashboard/Sign out) until they click through and get bounced by proxy.ts.
 */
export default function AuthSessionSync() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const clearAuth = useAuthStore((s) => s.clearAuth);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/me")
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          if (data.success) setUser(data.data.user);
          return;
        }
        if (res.status === 401 && user) clearAuth();
      })
      .catch(() => {
        // Network error — leave state as-is rather than logging the user out.
      });

    return () => {
      cancelled = true;
    };
    // Runs once on mount; intentionally not re-running on every user change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
