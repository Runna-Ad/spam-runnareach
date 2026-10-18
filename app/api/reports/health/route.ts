// ─────────────────────────────────────────────────────────────────────────────
// app/api/reports/health/route.ts
// Hourly health check. Supabase pg_cron calls it at :25 (migration 0045).
// Emails the ops list ONLY when an emergency rule fires (lib/reports/health.ts),
// at most once per problem per 24h; silent otherwise. ?dry=1 (still authorized)
// returns the text it would send without sending or recording anything.
//
// Auth: Authorization: Bearer <CRON_SECRET>, or pg_cron's Vault-held token
// (lib/cron-auth.ts isSchedulerAuthorized).
// ─────────────────────────────────────────────────────────────────────────────

import * as Sentry from "@sentry/nextjs";
import { type NextRequest } from "next/server";
import { isSchedulerAuthorized } from "@/lib/cron-auth";
import { sendNotification } from "@/lib/notify/send";
import { handleHealthCheck, type HealthRouteDeps } from "@/lib/reports/health";
import { gatherHealthSnapshot, recentHealthAlerts, recordHealthAlert, reportTenantIds } from "@/lib/reports/snapshot";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { HOBBY_CHECKIN_MARGIN, withCronMonitor } from "@/lib/sentry/cron";

export const dynamic = "force-dynamic";

const deps: Omit<HealthRouteDeps, "authorize"> = {
  tenantIds: reportTenantIds,
  snapshot: gatherHealthSnapshot,
  recentAlerts: recentHealthAlerts,
  send: (tenantId, message) =>
    sendNotification(createServiceRoleClient(), tenantId, { kind: "ops", fromName: "S.P.A.M. health", ...message }),
  recordAlert: recordHealthAlert,
  // No inbox could send it (e.g. the only one is the disconnected one): Sentry
  // alerts by email for free, so the emergency still reaches someone.
  undelivered: async (tenantId, problems, failed) => {
    console.error("[reports/health] alert undelivered:", tenantId, problems.map((p) => p.kind).join(","), failed.join(" | "));
    Sentry.captureMessage(`S.P.A.M. emergency could not be emailed: ${problems.map((p) => p.title).join("; ")}`, {
      level: "fatal",
      extra: { tenantId, failed, problems },
    });
  },
};

export async function GET(req: NextRequest) {
  const authorized = await isSchedulerAuthorized(req);
  const run = () => handleHealthCheck(req, { ...deps, authorize: async () => authorized });
  if (!authorized || req.nextUrl.searchParams.get("dry") === "1") return run();
  return withCronMonitor("spam-health-check", run, {
    schedule: { type: "crontab", value: "25 * * * *" },
    checkinMargin: HOBBY_CHECKIN_MARGIN,
    maxRuntime: 2,
    timezone: "UTC",
    failureIssueThreshold: 2,
    recoveryThreshold: 1,
  });
}
