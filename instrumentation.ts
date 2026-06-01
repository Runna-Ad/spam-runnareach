// Next.js instrumentation hook — loads Sentry on server start.
// This file is automatically picked up by Next.js (no config needed).

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
