// Sentry server-side configuration (Node.js runtime — server actions, API routes).
// Captures pipeline errors, Claude API failures, and server action crashes.

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // 100% in dev, 5% in production — pipeline is high-volume, stay well under free tier
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.05,

  // Attach local variable values to stack frames — makes debugging pipeline failures much easier
  includeLocalVariables: true,

  // Enable Sentry Logs product
  enableLogs: true,

  maxBreadcrumbs: 30,

  sendDefaultPii: false,
});
