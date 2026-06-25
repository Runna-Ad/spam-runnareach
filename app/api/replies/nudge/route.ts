// ─────────────────────────────────────────────────────────────────────────────
// app/api/replies/nudge/route.ts
// Reply-funnel NUDGE — re-engage a prospect who replied once then went quiet.
//
// When we sent a reply (draft_status='sent') ≥ NUDGE_DELAY_DAYS ago and they
// haven't responded since, we send a soft, warm follow-up that continues the
// conversation. Auto-sends when the composed draft is clearly good; a rare
// low-confidence draft is HELD for review (dropped into the inbox Drafts) so a
// bad email never auto-fires at a real prospect. Respects the 3-reply cap,
// snoozes/cooldowns, suppression, and the sender inbox's daily cap.
//
// Auth: Authorization: Bearer <CRON_SECRET>.
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest, NextResponse } from "next/server";
import { claudeIsAvailable } from "@/lib/anthropic/client";
import { recordClaudeCall } from "@/lib/anthropic/cost-tracking";
import { writeAuditLog } from "@/lib/audit/log";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import {
  effectiveSendsToday,
  bumpSendsTodayPayload,
  utcToday,
} from "@/lib/pitches/daily-cap";
import {
  composeNudgeWithClaude,
  composeNudgeHeuristic,
  nudgeLooksSafeToSend,
  type NudgeComposerInput,
} from "@/lib/replies/draft-composer";

export const maxDuration = 120;

const NUDGE_DELAY_DAYS = 3;
const MAX_REPLY_ATTEMPTS = 3;
const MAX_PER_RUN = 20;

// Prospect funnel states where a nudge would be inappropriate.
const INACTIVE_STATUSES = new Set([
  "suppressed", "booked", "won", "lost", "archived_no_meeting", "no_match",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient() as AnySupabase;
  const now = new Date();
  const cutoff = new Date(now.getTime() - NUDGE_DELAY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Candidate = the latest reply we SENT, old enough to nudge. Dedup to the most
  // recent sent reply per prospect.
  const { data: sentRows } = await supabase
    .from("replies")
    .select("id, tenant_id, prospect_id, pitch_id, from_email, subject, body_text, gmail_rfc_message_id, draft_sent_at")
    .eq("draft_status", "sent")
    .lt("draft_sent_at", cutoff)
    .order("draft_sent_at", { ascending: false })
    .limit(200);

  const latestByProspect = new Map<string, Record<string, unknown>>();
  for (const r of (sentRows ?? []) as Array<Record<string, unknown>>) {
    const pid = r.prospect_id as string | null;
    if (pid && !latestByProspect.has(pid)) latestByProspect.set(pid, r);
  }

  const results: Array<{ prospect: string; action: string; reason?: string }> = [];
  let processed = 0;

  for (const reply of latestByProspect.values()) {
    if (processed >= MAX_PER_RUN) break;
    const prospectId = reply.prospect_id as string;
    const tenantId = reply.tenant_id as string;
    const draftSentAt = reply.draft_sent_at as string;

    // ── Prospect gates ──────────────────────────────────────────────────────
    const { data: prospect } = await supabase
      .from("prospects")
      .select("id, company_name, language, status, reply_attempts, last_nudge_at, cooldown_until")
      .eq("id", prospectId)
      .maybeSingle();
    if (!prospect) continue;
    if (INACTIVE_STATUSES.has(prospect.status)) continue;
    const attempts = (prospect.reply_attempts as number | null) ?? 0;
    if (attempts >= MAX_REPLY_ATTEMPTS) continue;
    if (prospect.cooldown_until && prospect.cooldown_until > now.toISOString()) continue;
    if (prospect.last_nudge_at && prospect.last_nudge_at > cutoff) continue; // nudged recently

    // They responded after our last reply → the funnel handles it, don't nudge.
    const { count: newerInbound } = await supabase
      .from("replies")
      .select("id", { count: "exact", head: true })
      .eq("prospect_id", prospectId)
      .gt("received_at", draftSentAt);
    if ((newerInbound ?? 0) > 0) continue;

    // A draft is already waiting for human review → don't stack another.
    const { count: pendingDrafts } = await supabase
      .from("replies")
      .select("id", { count: "exact", head: true })
      .eq("prospect_id", prospectId)
      .eq("draft_status", "pending")
      .is("handled_at", null);
    if ((pendingDrafts ?? 0) > 0) continue;

    processed += 1;

    // ── Context (original pitch + research) ─────────────────────────────────
    let threadSubject: string | null = (reply.subject as string | null) ?? null;
    let originalPitchBody: string | null = null;
    let pitch: Record<string, unknown> | null = null;
    if (reply.pitch_id) {
      const { data } = await supabase
        .from("pitches")
        .select("subject, body_edited, body_original, sender_inbox_id, gmail_thread_id, gmail_message_id")
        .eq("id", reply.pitch_id as string)
        .maybeSingle();
      pitch = data ?? null;
      threadSubject = (pitch?.subject as string | null) ?? threadSubject;
      originalPitchBody = (pitch?.body_edited as string | null) ?? (pitch?.body_original as string | null) ?? null;
    }
    if (!pitch?.sender_inbox_id) {
      results.push({ prospect: prospect.company_name, action: "skipped", reason: "no sender inbox" });
      continue;
    }

    let whatTheyDo: string | null = null;
    let painSummary: string | null = null;
    const { data: research } = await supabase
      .from("research")
      .select("what_they_do, pain_points")
      .eq("prospect_id", prospectId)
      .is("superseded_at", null)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    whatTheyDo = (research?.what_they_do as string | null) ?? null;
    const pains = Array.isArray(research?.pain_points) ? research!.pain_points : [];
    painSummary = (pains[0] as { pain_label?: string } | undefined)?.pain_label ?? null;

    const language: "en" | "es" = prospect.language === "es" ? "es" : "en";
    const attemptNumber = attempts + 1;

    // ── Resolve inbox + daily cap (skip, don't burn, if we can't send) ──────
    const { data: inbox } = await supabase
      .from("sender_inboxes")
      .select("id, email, display_name, paused, gmail_refresh_token_encrypted, sends_today, last_reset_date, daily_cap")
      .eq("id", pitch.sender_inbox_id as string)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!inbox || inbox.paused || !inbox.gmail_refresh_token_encrypted) {
      results.push({ prospect: prospect.company_name, action: "skipped", reason: "inbox unavailable" });
      continue;
    }
    const sentToday = effectiveSendsToday(inbox.sends_today, inbox.last_reset_date);
    if (sentToday >= inbox.daily_cap) {
      results.push({ prospect: prospect.company_name, action: "skipped", reason: "daily cap" });
      continue;
    }

    // ── Compose ─────────────────────────────────────────────────────────────
    const composerInput: NudgeComposerInput = {
      contactFirstName: null,
      companyName: prospect.company_name,
      language,
      threadSubject,
      originalPitchBody,
      lastInboundBody: (reply.body_text as string | null) ?? null,
      whatTheyDo,
      painSummary,
      attemptNumber,
      senderFirstName: inbox.display_name?.trim().split(/\s+/)[0] || "Pedro",
      agencyName: "Runna",
    };

    let body: string;
    let subject: string;
    let claudeOk = false;
    if (claudeIsAvailable()) {
      const r = await composeNudgeWithClaude(composerInput);
      if (r.ok) {
        body = r.draft.body;
        subject = r.draft.subject;
        claudeOk = true;
        await recordClaudeCall({
          tenantId, model: r.model, entity_type: "reply_draft", entity_id: null,
          usage: r.usage, metadata: { prospect_id: prospectId, source: "nudge", attempt: attemptNumber },
        }).catch(() => {});
      } else {
        const f = composeNudgeHeuristic(composerInput);
        body = f.body; subject = f.subject;
      }
    } else {
      const f = composeNudgeHeuristic(composerInput);
      body = f.body; subject = f.subject;
    }

    const confident = claudeOk && nudgeLooksSafeToSend(body);
    const nowIso = new Date().toISOString();

    // ── Low confidence → HOLD for review (reopen the latest reply as a draft) ─
    if (!confident) {
      await supabase
        .from("replies")
        .update({
          auto_draft_body: body,
          draft_subject: subject,
          draft_status: "pending",
          auto_draft_generated_at: nowIso,
          handled_by: null,
          handled_at: null,
        })
        .eq("id", reply.id as string)
        .eq("tenant_id", tenantId);
      await supabase
        .from("prospects")
        .update({ last_nudge_at: nowIso })
        .eq("id", prospectId)
        .eq("tenant_id", tenantId);
      await writeAuditLog({
        tenantId, actorId: null, action: "reply.nudge_held", entityType: "prospect",
        entityId: prospectId, metadata: { reason: claudeOk ? "failed_sanity" : "claude_fallback", attempt: attemptNumber },
      }).catch(() => {});
      results.push({ prospect: prospect.company_name, action: "held_for_review" });
      continue;
    }

    // ── Confident → AUTO-SEND in-thread ─────────────────────────────────────
    const tokenResult = await getAccessToken(inbox.gmail_refresh_token_encrypted);
    if (!tokenResult.ok) {
      results.push({ prospect: prospect.company_name, action: "skipped", reason: "gmail auth" });
      continue;
    }
    const sendResult = await sendGmailMessage({
      accessToken: tokenResult.accessToken,
      fromEmail: inbox.email,
      fromName: inbox.display_name,
      to: reply.from_email as string,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      body,
      threadId: (pitch.gmail_thread_id as string | null) ?? undefined,
      originalMessageId: (reply.gmail_rfc_message_id as string | null) ?? (pitch.gmail_message_id as string | null) ?? undefined,
    });
    if (!sendResult.ok) {
      results.push({ prospect: prospect.company_name, action: "skipped", reason: `send failed: ${sendResult.error}` });
      continue;
    }

    await supabase
      .from("prospects")
      .update({ reply_attempts: attemptNumber, last_nudge_at: nowIso })
      .eq("id", prospectId)
      .eq("tenant_id", tenantId);
    await supabase
      .from("sender_inboxes")
      .update(bumpSendsTodayPayload(inbox.sends_today, inbox.last_reset_date))
      .eq("id", inbox.id);
    await writeAuditLog({
      tenantId, actorId: null, action: "reply.nudge_sent", entityType: "prospect",
      entityId: prospectId, metadata: { to: reply.from_email, attempt: attemptNumber, gmail_message_id: sendResult.gmailMessageId },
    }).catch(() => {});

    results.push({ prospect: prospect.company_name, action: `sent (attempt ${attemptNumber}/${MAX_REPLY_ATTEMPTS})` });
  }

  return NextResponse.json({ ok: true, day: utcToday(now), processed, results });
}
