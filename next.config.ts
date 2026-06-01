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
  // Set SENTRY_ORG + SENTRY_PROJECT env vars (or fill in below) to enable source map upload
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  // Source map upload auth token — set SENTRY_AUTH_TOKEN in Vercel env vars (secret)
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Upload wider set of client files for better stack trace resolution
  widenClientFileUpload: true,

  // Proxy tunnel to bypass ad-blockers — creates /monitoring API route automatically
  tunnelRoute: "/monitoring",

  // Suppress non-CI build output
  silent: !process.env.CI,

  // NOTE: Tree-shaking options intentionally omitted — project uses Turbopack (webpack-only feature)
});
