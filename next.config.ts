import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  // Pre-existing type drift (handwritten types.ts vs supabase-js v2.47 generics).
  // TODO: fix by regenerating types via `npm run db:types` after each migration.
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

export default withSentryConfig(nextConfig, {
  // Sentry project slug — set SENTRY_PROJECT + SENTRY_ORG env vars to enable source maps upload
  silent: true,
  // Disable source maps upload in local dev (no SENTRY_AUTH_TOKEN needed locally)
  sourcemaps: { disable: process.env.NODE_ENV !== "production" },
  // Don't auto-instrument — we call Sentry.init() manually in sentry.*.config.ts
  autoInstrumentServerFunctions: false,
});
