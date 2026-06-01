// Next.js instrumentation hook — loads Sentry on server start.
// This file is automatically picked up by Next.js (no config needed).

import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Automatically captures ALL unhandled server-side request errors (requires @sentry/nextjs >= 8.28.0)
export const onRequestError = Sentry.captureRequestError;
