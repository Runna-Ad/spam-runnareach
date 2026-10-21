// ─────────────────────────────────────────────────────────────────────────────
// app/api/benchmarks/research/route.ts
// Weekly "wanted facts" research. Supabase pg_cron calls it Wednesdays at
// 14:20 UTC (migration 0050). Up to 2 facts per tenant, one Claude + web search
// call each; proposals land as INACTIVE benchmarks for Pedro on /benchmarks
// (lib/benchmarks/research.ts). ?dry=1 (still authorized) researches ONE fact
// and returns the proposals without writing anything (the call is still paid
// and recorded in cost_tracking).
//
// Auth: Authorization: Bearer <CRON_SECRET>, or pg_cron's Vault-held token
// (lib/cron-auth.ts isSchedulerAuthorized). maxDuration 120 (vercel.json).
// ─────────────────────────────────────────────────────────────────────────────

import * as Sentry from "@sentry/nextjs";
import { type NextRequest } from "next/server";
import { isUnderDailyCap, recordClaudeCall } from "@/lib/anthropic/cost-tracking";
import { handleFactResearch, supabaseResearchStore, type RunDeps } from "@/lib/benchmarks/research";
import { isSchedulerAuthorized } from "@/lib/cron-auth";
import { sendNotification } from "@/lib/notify/send";
import { appUrl, reportTenantIds } from "@/lib/reports/snapshot";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { HOBBY_CHECKIN_MARGIN, withCronMonitor } from "@/lib/sentry/cron";

export const dynamic = "force-dynamic";

function deps(): Omit<RunDeps, "authorize"> {
  const db = createServiceRoleClient();
  return {
    store: supabaseResearchStore(db),
    tenantIds: reportTenantIds,
    underCap: isUnderDailyCap,
    recordCost: recordClaudeCall,
    notify: (tenantId, message) =>
      sendNotification(db, tenantId, { kind: "ops", fromName: "S.P.A.M. research", ...message }),
    warn: (message) => Sentry.captureMessage(message, { level: "warning" }),
    appUrl: appUrl(),
  };
}

export async function GET(req: NextRequest) {
  const authorized = await isSchedulerAuthorized(req);
  const run = () => handleFactResearch(req, { ...deps(), authorize: async () => authorized });
  if (!authorized) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (req.nextUrl.searchParams.get("dry") === "1") return run();
  return withCronMonitor("spam-fact-research", run, {
    schedule: { type: "crontab", value: "20 14 * * 3" },
    checkinMargin: HOBBY_CHECKIN_MARGIN,
    maxRuntime: 2,
    timezone: "UTC",
    failureIssueThreshold: 1,
    recoveryThreshold: 1,
  });
}
