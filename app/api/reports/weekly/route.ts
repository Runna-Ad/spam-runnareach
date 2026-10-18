// ─────────────────────────────────────────────────────────────────────────────
// app/api/reports/weekly/route.ts
// The Monday weekly report. Supabase pg_cron calls it at 13:10 UTC = 07:10
// Mexico City (migration 0045). Plain SQL and text, no AI
// (lib/reports/weekly.ts). ?dry=1 (still authorized) returns the text without
// sending it.
//
// Auth: Authorization: Bearer <CRON_SECRET>, or pg_cron's Vault-held token
// (lib/cron-auth.ts isSchedulerAuthorized).
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest } from "next/server";
import { isSchedulerAuthorized } from "@/lib/cron-auth";
import { sendNotification } from "@/lib/notify/send";
import { handleWeeklyReport, type WeeklyRouteDeps } from "@/lib/reports/weekly";
import { gatherWeeklyRaw, reportTenantIds } from "@/lib/reports/snapshot";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { HOBBY_CHECKIN_MARGIN, withCronMonitor } from "@/lib/sentry/cron";

export const dynamic = "force-dynamic";

const deps: Omit<WeeklyRouteDeps, "authorize"> = {
  tenantIds: reportTenantIds,
  gather: gatherWeeklyRaw,
  send: (tenantId, message) =>
    sendNotification(createServiceRoleClient(), tenantId, { kind: "ops", fromName: "S.P.A.M. weekly", ...message }),
};

export async function GET(req: NextRequest) {
  const authorized = await isSchedulerAuthorized(req);
  const run = () => handleWeeklyReport(req, { ...deps, authorize: async () => authorized });
  if (!authorized || req.nextUrl.searchParams.get("dry") === "1") return run();
  return withCronMonitor("spam-weekly-report", run, {
    schedule: { type: "crontab", value: "10 13 * * 1" },
    checkinMargin: HOBBY_CHECKIN_MARGIN,
    maxRuntime: 2,
    timezone: "UTC",
    failureIssueThreshold: 1,
    recoveryThreshold: 1,
  });
}
