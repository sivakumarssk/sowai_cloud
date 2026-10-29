import type { NextConfig } from "next";
import { assertRealProvisioner } from "./src/lib/provisioning/guard";

// Next loads .env before this file, so `next build` / `next start` refuse a
// live environment (APP_ENV=production or rzp_live_ key) without PROVISIONER=proxmox.
assertRealProvisioner();

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Lets `next dev` serve HMR / dev assets when opened via the LAN IP (e.g. from a phone).
  allowedDevOrigins: ["192.168.*.*"],
  async redirects() {
    return [
      { source: "/policy", destination: "/privacy", permanent: true },
      { source: "/privacy-policy", destination: "/privacy", permanent: true },
      { source: "/refund-policy", destination: "/refund", permanent: true },
    ];
  },
  experimental: {
    // The dev filesystem cache kept serving a stale Tailwind stylesheet across
    // restarts (new utility classes never appeared), so dev compiles fresh.
    turbopackFileSystemCacheForDev: false,
  },
};

export default nextConfig;
