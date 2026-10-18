import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  experimental: {
    // The dev filesystem cache kept serving a stale Tailwind stylesheet across
    // restarts (new utility classes never appeared), so dev compiles fresh.
    turbopackFileSystemCacheForDev: false,
  },
};

export default nextConfig;
