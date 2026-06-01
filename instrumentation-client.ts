// Sentry browser / client-side configuration.
// Next.js automatically loads this file for the client bundle — no import needed.
// Renamed from sentry.client.config.ts to instrumentation-client.ts (current SDK pattern).

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // 100% sampling in dev (all errors visible), 10% in production (stays under free tier)
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  // Session Replay: record 10% of all sessions, 100% of sessions with errors
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  // Enable Sentry Logs product (structured log capture)
  enableLogs: true,

  // Hard cap reminder: also enable Spike Protection in Sentry dashboard
  // Settings → Project → Spike Protection → ON  (free tier: 10k events/month)
  maxBreadcrumbs: 30,

  sendDefaultPii: false,

  integrations: [
    Sentry.replayIntegration(),
  ],
});

// Hook into App Router navigation transitions for client-side tracing
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
