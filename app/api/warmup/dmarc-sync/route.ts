// ─────────────────────────────────────────────────────────────────────────────
// app/api/warmup/dmarc-sync/route.ts
// Daily cron — ingest DMARC aggregate reports from the rua= mailbox into
// dmarc_reports / dmarc_report_records.
//
// runnareach.com's _dmarc record already points rua= at pedro@runnareach.com,
// so daily gzip/zip XML reports already land in the mailbox we hold a Gmail
// OAuth token for. This reads + parses + stores them. No DNS change, no
// external account. Complements postmaster-sync (which needs high volume).
//
// Auth: Authorization: Bearer <CRON_SECRET>.
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getAccessToken } from "@/lib/gmail/client";
import { ingestDmarcReports } from "@/lib/warmup/dmarc-reports";

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

type InboxRow = {
  tenant_id: string;
  email: string;
  gmail_refresh_token_encrypted: string | null;
};

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const results: Array<{ tenant_id: string; mailbox: string; status: string }> = [];

  try {
    await Sentry.withMonitor(
      "dmarc-sync",
      async () => {
        const { data: inboxes } = await supabase
          .from("sender_inboxes")
          .select("tenant_id, email, gmail_refresh_token_encrypted")
          .not("gmail_refresh_token_encrypted", "is", null)
          .returns<InboxRow[]>();

        if (!inboxes || inboxes.length === 0) return;

        // One mailbox can serve many sender rows — dedupe by (tenant, email).
        const seen = new Set<string>();
        for (const inbox of inboxes) {
          if (!inbox.gmail_refresh_token_encrypted) continue;
          const key = `${inbox.tenant_id}:${inbox.email.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const tok = await getAccessToken(inbox.gmail_refresh_token_encrypted);
          if (!tok.ok) {
            results.push({ tenant_id: inbox.tenant_id, mailbox: inbox.email, status: `token_error: ${tok.error}` });
            continue;
          }

          const ingest = await ingestDmarcReports(
            supabase as unknown as Parameters<typeof ingestDmarcReports>[0],
            inbox.tenant_id,
            tok.accessToken,
            14,
          );

          results.push({
            tenant_id: inbox.tenant_id,
            mailbox: inbox.email,
            status:
              `scanned ${ingest.messages_scanned}, parsed ${ingest.reports_parsed}, ` +
              `inserted ${ingest.reports_inserted} reports / ${ingest.records_inserted} records` +
              (ingest.errors.length ? ` (${ingest.errors.length} errors)` : ""),
          });

          if (ingest.errors.length) {
            console.warn(`[dmarc-sync] ${inbox.email} errors:`, ingest.errors.slice(0, 5));
          }
        }
      },
      {
        schedule: { type: "crontab", value: "0 9 * * *" },
        checkinMargin: 30, // Vercel Hobby crons can fire 20–30 min late
        maxRuntime: 3,
        timezone: "UTC",
        failureIssueThreshold: 2,
        recoveryThreshold: 1,
      },
    );
  } catch (err) {
    console.error("[dmarc-sync] Fatal error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  return NextResponse.json({ ok: true, synced: results.length, results });
}
