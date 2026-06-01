// Sentry server-side configuration (Node.js / Next.js server actions).
// Captures pipeline errors, Claude API failures, and server action crashes.

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Only capture errors in production
  enabled: process.env.NODE_ENV === "production",

  // Very low trace sampling — pipeline is high-volume, keep well under free tier
  tracesSampleRate: 0.05,

  maxBreadcrumbs: 30,

  sendDefaultPii: false,
});
