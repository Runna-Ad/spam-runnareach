// ─────────────────────────────────────────────────────────────────────────────
// app/api/warmup/engine/route.ts
// Warmup engine — triggered by Vercel Cron every 30 minutes.
//
// Logic per tick:
//   1. Load all active warmup_config rows.
//   2. For each config, check if daily counter needs reset (new calendar day).
//   3. Run IMAP checks on previous sends to track inbox/spam placement.
//   4. Auto-pause if spam rate exceeds threshold.
//   5. Send remaining emails for today via main Gmail account (OAuth).
//   6. Round-robin buddy selection + logging.
//
// Auth: CRON_SECRET header (Vercel sends automatically for cron routes).
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import {
  getAllActiveConfigs,
  updateWarmupConfigDay,
  resetDailyCount,
  getActiveBuddies,
  markBuddyUsed,
  getRandomTemplate,
  insertWarmupLog,
  updateWarmupLog,
  getPendingInboxChecks,
  getRecentLogByConfig,
} from "@/lib/warmup/queries";
import {
  checkMessageInbox,
  processIncomingWarmupEmails,
} from "@/lib/warmup/imap";
import {
  analyzeSpamRate,
  shouldIncrementDay,
  computeDayPlan,
  pickNextBuddyIndex,
} from "@/lib/warmup/intelligence";
import { getDailyTarget } from "@/lib/warmup/types";
import type { EngineTickResult, WarmupConfig } from "@/lib/warmup/types";

// ── Auth guard ─────────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

// ── Inbox (sending account) retrieval ─────────────────────────────────────────

type InboxRow = {
  id: string;
  email: string;
  display_name: string;
  gmail_refresh_token_encrypted: string | null;
};

async function getSendingInbox(
  tenantId: string,
  sendingEmail: string,
): Promise<InboxRow | null> {
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("sender_inboxes")
    .select("id, email, display_name, gmail_refresh_token_encrypted")
    .eq("tenant_id", tenantId)
    .eq("email", sendingEmail)
    .eq("paused", false)
    .maybeSingle<InboxRow>();
  return data ?? null;
}

// ── Engine tick for a single config ───────────────────────────────────────────

async function processConfig(config: WarmupConfig): Promise<EngineTickResult> {
  const result: EngineTickResult = {
    config_id: config.id,
    sending_email: config.sending_email,
    day: config.current_day,
    sent: 0,
    checked: 0,
    inbox_rate: null,
  };

  try {
    const today = new Date().toISOString().split("T")[0] as string;
    const isNewDay = shouldIncrementDay(config);

    // ── Step 1: Reset daily count + advance day counter on new calendar day
    if (isNewDay) {
      const newDay = config.current_day + 1;
      await resetDailyCount(config.id);
      await updateWarmupConfigDay(config.id, {
        current_day: newDay,
        daily_target: getDailyTarget(newDay),
      });
      // Update local copy for this tick
      config.current_day = newDay;
      config.emails_sent_today = 0;
      config.last_reset_date = today;
    }

    // ── Step 2: IMAP check of previous sends (landed in inbox vs spam?)
    const pendingChecks = await getPendingInboxChecks(config.id);
    const buddies = await getActiveBuddies();

    for (const log of pendingChecks) {
      if (!log.message_id || !log.buddy_id) continue;
      const buddy = buddies.find((b) => b.id === log.buddy_id);
      if (!buddy) continue;

      const check = await checkMessageInbox(buddy, log.message_id);
      if (check !== null) {
        await updateWarmupLog(log.id, {
          landed_in_inbox: check.foundInInbox || check.movedToInbox,
        });
        result.checked++;
      }
    }

    // ── Step 3: Analyze spam rate — auto-pause if over threshold
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentLogs = await getRecentLogByConfig(config.id, sevenDaysAgo);
    const spamAnalysis = analyzeSpamRate(recentLogs);
    if (spamAnalysis.inboxRate !== null) result.inbox_rate = spamAnalysis.inboxRate;

    if (spamAnalysis.shouldPause) {
      await updateWarmupConfigDay(config.id, {
        status: "paused",
        pause_reason: spamAnalysis.reason ?? "Auto-paused: high spam rate",
      });
      result.skipped_reason = spamAnalysis.reason ?? "High spam rate";
      return result;
    }

    // ── Step 4: Compute how many to send this tick
    const dayPlan = computeDayPlan({ ...config });
    if (!dayPlan.shouldSend) {
      result.skipped_reason = `Daily target (${dayPlan.targetForToday}) already reached`;
      return result;
    }

    // ── Step 5: Get sending inbox credentials
    const inbox = await getSendingInbox(config.tenant_id, config.sending_email);
    if (!inbox?.gmail_refresh_token_encrypted) {
      result.skipped_reason = "No active Gmail inbox found for sending email";
      return result;
    }

    const tokenResult = await getAccessToken(inbox.gmail_refresh_token_encrypted);
    if (!tokenResult.ok) {
      result.skipped_reason = `Token refresh failed: ${tokenResult.error}`;
      return result;
    }

    // ── Step 6: Send all remaining emails for today in one tick
    // (Cron fires once/day on Hobby tier — no burst risk, send the full daily target)
    const sendThisTick = dayPlan.remainingToday;
    let buddyIndex = config.last_buddy_index;

    for (let i = 0; i < sendThisTick; i++) {
      if (buddies.length === 0) break;

      buddyIndex = pickNextBuddyIndex(buddyIndex, buddies.length);
      const buddy = buddies[buddyIndex];
      if (!buddy) continue;

      const template = await getRandomTemplate();
      if (!template) {
        console.warn("[warmup/engine] No templates in DB");
        break;
      }

      // Resolve buddy email from env
      const buddyEmail = process.env[buddy.email_env_var];
      if (!buddyEmail) {
        console.warn(`[warmup/engine] Missing env var ${buddy.email_env_var}`);
        continue;
      }

      // Small jitter (0–3s) to look organic
      await new Promise((r) => setTimeout(r, Math.random() * 3000));

      const sendResult = await sendGmailMessage({
        accessToken: tokenResult.accessToken,
        fromEmail: inbox.email,
        fromName: inbox.display_name,
        to: buddyEmail,
        subject: template.subject,
        body: template.body_text,
      });

      if (sendResult.ok) {
        await insertWarmupLog({
          tenant_id: config.tenant_id,
          config_id: config.id,
          buddy_id: buddy.id,
          direction: "sent",
          subject: template.subject,
          message_id: sendResult.gmailMessageId || null,
          thread_id: sendResult.threadId ?? null,
          landed_in_inbox: null,
          reply_sent: false,
          day_number: config.current_day,
        });

        await markBuddyUsed(buddy.id);
        result.sent++;
      } else {
        console.error(`[warmup/engine] Send failed for buddy ${buddy.id}:`, sendResult.error);
      }
    }

    // ── Step 7: Update config counters
    if (result.sent > 0 || buddyIndex !== config.last_buddy_index) {
      await updateWarmupConfigDay(config.id, {
        emails_sent_today: (config.emails_sent_today ?? 0) + result.sent,
        last_buddy_index: buddyIndex,
      });
    }

    // ── Step 8: Process incoming replies from buddies
    // We look for unread warmup emails in each buddy's inbox and auto-reply.
    // Process at most 2 buddies per tick to stay within the 60s timeout.
    const replyTemplates = [
      { subject: "Re:", reply_text: "Thanks for reaching out! Talk soon." },
      { subject: "Re:", reply_text: "Got it! I'll get back to you shortly." },
      { subject: "Re:", reply_text: "Appreciate you sending this over." },
      { subject: "Re:", reply_text: "Sounds good! Let me take a look and follow up." },
    ];

    for (const buddy of buddies.slice(0, 2)) {
      try {
        await processIncomingWarmupEmails(buddy, config.sending_email, replyTemplates);
      } catch (err) {
        console.warn(`[warmup/engine] processIncoming for buddy ${buddy.id} failed:`, err);
      }
    }

  } catch (err) {
    console.error(`[warmup/engine] processConfig error (${config.id}):`, err);
    result.skipped_reason = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return result;
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const allResults: EngineTickResult[] = [];

  try {
    const configs = await getAllActiveConfigs();
    for (const config of configs) {
      const result = await processConfig(config);
      allResults.push(result);
    }
  } catch (err) {
    console.error("[warmup/engine] Fatal error:", err);
    return NextResponse.json(
      { error: "Engine error", details: String(err) },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    duration_ms: Date.now() - startTime,
    processed: allResults.length,
    results: allResults,
  });
}
