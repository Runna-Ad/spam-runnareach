import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  // Pre-existing type drift (handwritten types.ts vs supabase-js v2.47 generics).
  // TODO: fix by regenerating types via `supabase gen types` with a PAT.
  typescript: { ignoreBuildErrors: true },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "https", hostname: "logo.clearbit.com" },
    ],
  },
  experimental: {
    // Placeholder for Next 16 experimental flags as needed
  },
};

export default nextConfig;
