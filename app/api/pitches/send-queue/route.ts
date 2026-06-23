// ─────────────────────────────────────────────────────────────────────────────
// app/api/pitches/send-queue/route.ts
// Drip-send queued cold pitches — triggered by Vercel Cron.
//
// A pitch is "queued" when status='approved' AND scheduled_send_at <= now.
// Each tick sends at most SEND_PER_TICK pitches (jittered), and never exceeds
// each inbox's daily_cap. Leftovers stay queued and roll to the next tick/day,
// so a batch drips out gradually instead of bursting — protecting the warmed
// sending domain's reputation.
//
// Auth: Authorization: Bearer <CRON_SECRET>.
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";

// Conservative drip. The cron runs daily (Hobby-tier limit), so this is the
// cold-email volume PER DAY: a queue of N pitches goes out ~SEND_PER_TICK/day,
// spread across days, which is gentler on the freshly-warmed domain than
// bursting toward the inbox daily_cap. The inbox daily_cap is still the hard
// ceiling. Tune up once the domain has a longer sending history.
const SEND_PER_TICK = 6;
const JITTER_MS = 8_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

type DuePitch = {
  id: string;
  tenant_id: string;
  subject: string;
  body_original: string | null;
  body_edited: string | null;
  prospect_id: string;
  contact_id: string | null;
  sender_inbox_id: string | null;
};

type SendOutcome = {
  pitch_id: string;
  status: "sent" | "skipped" | "error";
  reason?: string;
};

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient() as AnySupabase;
  const nowIso = new Date().toISOString();
  const results: SendOutcome[] = [];

  // Inbox send-budget cache for THIS tick: tracks how many we've already sent
  // per inbox so we respect daily_cap without re-reading after every send.
  const inboxCache = new Map<
    string,
    {
      email: string;
      display_name: string;
      token: string | null;
      paused: boolean;
      sends_today: number; // running count, written back after each send
      remaining: number; // daily_cap - sends_today, decremented as we send
    }
  >();

  try {
    // Due = approved + scheduled_send_at in the past. Oldest first (FIFO).
    const { data: due } = await supabase
      .from("pitches")
      .select(
        "id, tenant_id, subject, body_original, body_edited, prospect_id, contact_id, sender_inbox_id",
      )
      .eq("status", "approved")
      .not("scheduled_send_at", "is", null)
      .lte("scheduled_send_at", nowIso)
      .order("scheduled_send_at", { ascending: true })
      .limit(50);

    const duePitches = (due ?? []) as DuePitch[];
    let sentThisTick = 0;

    for (const pitch of duePitches) {
      if (sentThisTick >= SEND_PER_TICK) break;
      if (!pitch.sender_inbox_id) {
        results.push({ pitch_id: pitch.id, status: "skipped", reason: "No sender inbox" });
        continue;
      }

      // ── Resolve + cache the inbox budget ────────────────────────────────
      let inbox = inboxCache.get(pitch.sender_inbox_id);
      if (!inbox) {
        const { data: row } = await supabase
          .from("sender_inboxes")
          .select("id, email, display_name, daily_cap, sends_today, paused, gmail_refresh_token_encrypted")
          .eq("id", pitch.sender_inbox_id)
          .maybeSingle();
        if (!row) {
          results.push({ pitch_id: pitch.id, status: "skipped", reason: "Inbox not found" });
          continue;
        }
        inbox = {
          email: row.email,
          display_name: row.display_name,
          token: row.gmail_refresh_token_encrypted,
          paused: row.paused,
          sends_today: row.sends_today ?? 0,
          remaining: Math.max(0, (row.daily_cap ?? 0) - (row.sends_today ?? 0)),
        };
        inboxCache.set(pitch.sender_inbox_id, inbox);
      }

      if (inbox.paused) {
        results.push({ pitch_id: pitch.id, status: "skipped", reason: "Inbox paused" });
        continue;
      }
      if (!inbox.token) {
        results.push({ pitch_id: pitch.id, status: "skipped", reason: "Inbox not connected" });
        continue;
      }
      if (inbox.remaining <= 0) {
        // Cap reached for this inbox today — leave queued for tomorrow.
        results.push({ pitch_id: pitch.id, status: "skipped", reason: "Daily cap reached" });
        continue;
      }

      // ── Resolve the contact email ───────────────────────────────────────
      if (!pitch.contact_id) {
        results.push({ pitch_id: pitch.id, status: "skipped", reason: "No contact" });
        continue;
      }
      const { data: contact } = await supabase
        .from("prospect_contacts")
        .select("email, full_name")
        .eq("id", pitch.contact_id)
        .maybeSingle();
      const toEmail: string | null = contact?.email ?? null;
      if (!toEmail) {
        results.push({ pitch_id: pitch.id, status: "skipped", reason: "Contact has no email" });
        continue;
      }
      const body = (pitch.body_edited ?? pitch.body_original ?? "").trim();
      if (!body) {
        results.push({ pitch_id: pitch.id, status: "skipped", reason: "Empty body" });
        continue;
      }

      // ── Optimistic lock: claim the pitch (approved → sending) ────────────
      const { data: locked } = await supabase
        .from("pitches")
        .update({ status: "sending" })
        .eq("id", pitch.id)
        .eq("status", "approved")
        .select("id")
        .maybeSingle();
      if (!locked) {
        // Someone else grabbed it (concurrent tick) — skip.
        continue;
      }

      // ── Send ─────────────────────────────────────────────────────────────
      const tokenResult = await getAccessToken(inbox.token);
      if (!tokenResult.ok) {
        await supabase.from("pitches").update({ status: "approved" }).eq("id", pitch.id);
        results.push({ pitch_id: pitch.id, status: "error", reason: `Auth: ${tokenResult.error}` });
        continue;
      }

      if (sentThisTick > 0) {
        await new Promise((r) => setTimeout(r, Math.random() * JITTER_MS));
      }

      const toName = contact?.full_name ?? null;
      const sendResult = await sendGmailMessage({
        accessToken: tokenResult.accessToken,
        fromEmail: inbox.email,
        fromName: inbox.display_name,
        to: toName ? `"${String(toName).replace(/"/g, "")}" <${toEmail}>` : toEmail,
        subject: pitch.subject,
        body,
      });

      if (!sendResult.ok) {
        await supabase.from("pitches").update({ status: "approved" }).eq("id", pitch.id);
        results.push({ pitch_id: pitch.id, status: "error", reason: `Send: ${sendResult.error}` });
        continue;
      }

      // ── Persist success ──────────────────────────────────────────────────
      const sentAt = new Date().toISOString();
      await supabase
        .from("pitches")
        .update({
          status: "sent",
          sent_at: sentAt,
          gmail_message_id: sendResult.gmailMessageId,
          gmail_thread_id: sendResult.threadId ?? null,
          sequence_step: 1,
          next_followup_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .eq("id", pitch.id);

      // Increment the inbox's daily counter (cache-tracked to stay correct
      // across multiple sends from the same inbox within this tick).
      inbox.sends_today += 1;
      inbox.remaining -= 1;
      await supabase
        .from("sender_inboxes")
        .update({ sends_today: inbox.sends_today })
        .eq("id", pitch.sender_inbox_id);

      sentThisTick += 1;
      results.push({ pitch_id: pitch.id, status: "sent" });
    }

    return NextResponse.json({
      ok: true,
      sent: results.filter((r) => r.status === "sent").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      errors: results.filter((r) => r.status === "error").length,
      results,
    });
  } catch (err) {
    console.error("[pitches/send-queue] fatal:", err);
    return NextResponse.json({ error: "Send-queue error", details: String(err) }, { status: 500 });
  }
}
