import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Lets `next dev` serve HMR / dev assets when opened via the LAN IP (e.g. from a phone).
  allowedDevOrigins: ["192.168.*.*"],
  experimental: {
    // The dev filesystem cache kept serving a stale Tailwind stylesheet across
    // restarts (new utility classes never appeared), so dev compiles fresh.
    turbopackFileSystemCacheForDev: false,
  },
};

export default nextConfig;
