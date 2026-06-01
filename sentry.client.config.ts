// Sentry client-side configuration (browser).
// Initializes error tracking for React components and client actions.

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Only capture errors in production — skip local dev noise
  enabled: process.env.NODE_ENV === "production",

  // 10% of transactions sampled for performance — keeps us well under free tier
  tracesSampleRate: 0.1,

  // Hard cap: stop sending after 10k events/month (free tier limit)
  // Sentry Spike Protection must also be enabled in the Sentry dashboard
  // Settings → Project → Spike Protection → ON
  maxBreadcrumbs: 30,

  // Don't send PII — no user emails, IPs, etc.
  sendDefaultPii: false,
});
