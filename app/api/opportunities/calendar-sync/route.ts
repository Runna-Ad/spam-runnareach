// ─────────────────────────────────────────────────────────────────────────────
// app/api/opportunities/calendar-sync/route.ts
// Google Calendar booking sync. Supabase pg_cron calls it at :05, hourly in the
// send window and right after it, then once a day at 13:05 (migrations 0044,
// 0053); it can also be called by hand with the cron secret.
//
// For every tenant with a Google-connected inbox, runs one sync as that
// tenant's system actor (lib/opportunities/calendar-sync.ts): bookings become
// meeting_booked opportunities, cancellations mark them lost, and each one gets
// one lead alert, driven by the row's alert markers (migration 0047). Until Google is
// reconnected with calendar.readonly the report says needsReconnect (HTTP 200).
//
// Auth: Authorization: Bearer <CRON_SECRET>, or pg_cron's Vault-held token
// (lib/cron-auth.ts isSchedulerAuthorized).
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest } from "next/server";
import { systemActorFor } from "@/lib/actor";
import { isCronAuthorized, isSchedulerAuthorized } from "@/lib/cron-auth";
import { writeAuditLog } from "@/lib/audit/log";
import { getAccessToken } from "@/lib/gmail/client";
import { handleCalendarSync, syncCalendarWith } from "@/lib/opportunities/calendar-sync";
import { listRecentEvents } from "@/lib/opportunities/google-calendar";
import { sendNotification } from "@/lib/notify/send";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";

async function connectedTenantIds(): Promise<string[]> {
  const { data, error } = await createServiceRoleClient()
    .from("sender_inboxes")
    .select("tenant_id")
    .not("gmail_refresh_token_encrypted", "is", null);
  if (error) throw new Error(`inbox lookup failed: ${error.message}`);
  return [...new Set((data ?? []).map((r) => r.tenant_id))];
}

async function handle(req: NextRequest) {
  // Booking alerts are claimed only while 60s of maxDuration remain, counted from here.
  const startedAt = Date.now();
  return handleCalendarSync(req, {
    authorize: async (r) => (await isSchedulerAuthorized(r)) || isCronAuthorized(r),
    tenantIds: connectedTenantIds,
    actorFor: systemActorFor,
    sync: (actor) =>
      syncCalendarWith(actor, {
        getAccessToken,
        listEvents: (token) => listRecentEvents(token),
        writeAuditLog,
        notify: (message) => sendNotification(actor.supabase, actor.user.tenantId, message),
        startedAt,
      }),
  });
}

export const GET = handle;
export const POST = handle;
