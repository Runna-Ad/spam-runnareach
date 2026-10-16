// ─────────────────────────────────────────────────────────────────────────────
// lib/sentry/cron.ts
// Sentry.withMonitor wrapper for Vercel cron routes.
//
// withMonitor only QUEUES the closing check-in. A route that returns right
// after it lets Vercel freeze the function before the queue is sent, so Sentry
// sees "in_progress" and then nothing → "timed out". Flushing before the route
// returns makes the closing check-in actually leave.
//
// HOBBY_CHECKIN_MARGIN: Vercel Hobby runs a cron at a fixed random minute
// inside the scheduled hour (postmaster-sync fired at :46 every day), so a
// margin under 60 min reports a "missed" run every day.
// ─────────────────────────────────────────────────────────────────────────────

import * as Sentry from "@sentry/nextjs";

export const HOBBY_CHECKIN_MARGIN = 60;

const FLUSH_TIMEOUT_MS = 2_000;

export async function withCronMonitor<T>(
  slug: string,
  callback: () => Promise<T>,
  config: Parameters<typeof Sentry.withMonitor>[2],
): Promise<T> {
  try {
    return await Sentry.withMonitor(slug, callback, config);
  } finally {
    await Sentry.flush(FLUSH_TIMEOUT_MS);
  }
}
