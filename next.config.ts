import type { NextConfig } from "next";
import { assertEnvironment } from "./src/lib/environment";

// Next loads .env before this file, so `next dev` / `next build` / `next start`
// refuse an environment that mixes development and production (src/lib/environment.ts).
assertEnvironment();

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
