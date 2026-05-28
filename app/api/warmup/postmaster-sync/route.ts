// ─────────────────────────────────────────────────────────────────────────────
// app/api/warmup/postmaster-sync/route.ts
// Daily cron — fetch Google Postmaster Tools stats and snapshot to domain_health.
//
// Requires the tenant Gmail OAuth token to have the postmaster.readonly scope.
// If the scope is missing, this endpoint gracefully logs a warning and exits.
//
// Auth: CRON_SECRET header.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAccessToken } from "@/lib/gmail/client";
import { fetchDomainStats, listPostmasterDomains } from "@/lib/warmup/postmaster";
import {
  upsertDomainHealth,
  getWarmupConfig,
  updateWarmupConfigDay,
} from "@/lib/warmup/queries";
import { shouldPauseFromPostmaster } from "@/lib/warmup/intelligence";

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

  const supabase = await createClient();
  const results: { tenant_id: string; domain: string; status: string }[] = [];

  try {
    // Load all active inboxes that have Gmail tokens
    const { data: inboxes } = await supabase
      .from("sender_inboxes")
      .select("tenant_id, email, gmail_refresh_token_encrypted")
      .not("gmail_refresh_token_encrypted", "is", null)
      .eq("paused", false)
      .returns<InboxRow[]>();

    if (!inboxes || inboxes.length === 0) {
      return NextResponse.json({ ok: true, message: "No inboxes with tokens found" });
    }

    for (const inbox of inboxes) {
      if (!inbox.gmail_refresh_token_encrypted) continue;

      const tokenResult = await getAccessToken(inbox.gmail_refresh_token_encrypted);
      if (!tokenResult.ok) {
        results.push({ tenant_id: inbox.tenant_id, domain: inbox.email, status: `token_error: ${tokenResult.error}` });
        continue;
      }

      const accessToken = tokenResult.accessToken;

      // Extract domain from sending email
      const domain = inbox.email.split("@")[1];
      if (!domain) continue;

      // Check if domain is registered in Postmaster Tools
      const registeredDomains = await listPostmasterDomains(accessToken);
      if (!registeredDomains.includes(domain)) {
        results.push({ tenant_id: inbox.tenant_id, domain, status: "not_registered_in_postmaster" });
        continue;
      }

      // Fetch today's stats
      const stats = await fetchDomainStats(accessToken, domain);
      if (!stats) {
        results.push({ tenant_id: inbox.tenant_id, domain, status: "no_data_from_postmaster" });
        continue;
      }

      // Persist to domain_health
      await upsertDomainHealth({
        tenant_id: inbox.tenant_id,
        domain,
        recorded_date: stats.date,
        domain_reputation: stats.domainReputation,
        ip_reputation: stats.ipReputation,
        spam_rate: stats.userReportedSpamRatio,
        spf_success_ratio: stats.spfSuccessRatio,
        dkim_success_ratio: stats.dkimSuccessRatio,
        dmarc_success_ratio: stats.dmarcSuccessRatio,
        inbound_encryption_ratio: stats.inboundEncryptionRatio,
        raw_response: stats.raw as Record<string, unknown>,
      });

      // Auto-pause warmup if Postmaster signals danger
      const config = await getWarmupConfig(inbox.tenant_id);
      if (config && config.status === "active") {
        const health = {
          id: "",
          tenant_id: inbox.tenant_id,
          domain,
          recorded_date: stats.date,
          domain_reputation: stats.domainReputation,
          ip_reputation: stats.ipReputation,
          spam_rate: stats.userReportedSpamRatio,
          spf_success_ratio: stats.spfSuccessRatio,
          dkim_success_ratio: stats.dkimSuccessRatio,
          dmarc_success_ratio: stats.dmarcSuccessRatio,
          inbound_encryption_ratio: stats.inboundEncryptionRatio,
          created_at: new Date().toISOString(),
        };

        const pauseSignal = shouldPauseFromPostmaster(health);
        if (pauseSignal.pause) {
          await updateWarmupConfigDay(config.id, {
            status: "paused",
            pause_reason: pauseSignal.reason ?? "Auto-paused: Postmaster signal",
          });
          results.push({ tenant_id: inbox.tenant_id, domain, status: `auto_paused: ${pauseSignal.reason}` });
          continue;
        }
      }

      results.push({
        tenant_id: inbox.tenant_id,
        domain,
        status: `ok: ${stats.domainReputation ?? "unspecified"} reputation, spam_rate=${((stats.userReportedSpamRatio ?? 0) * 100).toFixed(2)}%`,
      });
    }
  } catch (err) {
    console.error("[postmaster-sync] Fatal error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  return NextResponse.json({ ok: true, synced: results.length, results });
}
