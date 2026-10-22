// ─────────────────────────────────────────────────────────────────────────────
// app/api/pitches/send-queue/route.ts
// Drip-send queued cold pitches — triggered by Vercel Cron.
//
// A pitch is "queued" when status='approved' AND scheduled_send_at <= now.
// Each tick sends at most one pitch per inbox and SEND_PER_TICK in total
// (lib/pitches/send-pacing.ts), and never exceeds each inbox's daily_cap. Leftovers stay queued and roll to the next tick/day,
// so a batch drips out gradually instead of bursting — protecting the warmed
// sending domain's reputation.
//
// Auth: Authorization: Bearer <CRON_SECRET>.
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest, NextResponse } from "next/server";
import { isSchedulerAuthorized } from "@/lib/cron-auth";
import { withHeartbeat } from "@/lib/reports/heartbeat";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import { bodyWithFooter, getOutboundCompliance } from "@/lib/compliance/outbound";
import {
  effectiveSendsToday,
  hasTimeToClaim,
  releaseSendSlot,
  reserveSendSlot,
  type SlotClient,
} from "@/lib/pitches/daily-cap";
import { createRunPacer, PER_RUN_TOTAL } from "@/lib/pitches/send-pacing";
import { holdDoubtfulAutoApproval, latestApproval, sendTimeVerdictAction } from "@/lib/pitches/send-time-hold";
import { hasUsableEmail } from "@/lib/research/email-utils";
import { isEmailOnDncList, type DncClient } from "@/lib/discover/dnc-check";
import { findSentMessage } from "@/lib/gmail/read";
import { firstTouchConflict } from "@/lib/pitches/send-guards";
import { verifyRecipient } from "@/lib/research/verify-recipient";
import { inboxBounceBlock } from "@/lib/autopilot/bounce-breaker";
import { reconcileSignOff, senderIdentity } from "@/lib/pitches/sender-identity";
import { auditGateHold, checkPitchGate } from "@/lib/pitches/gate";
import { recordPitchEvent } from "@/lib/pitches/events";
import { editRatio } from "@/lib/pitches/decision";
import { recordSendFailure } from "@/lib/autopilot/send-failures";
import { describeFailures, gateAllows } from "@/lib/pitches/send-gate";
import {
  prospectSendBlock,
  queueReleaseFor,
  recheckBeforeSend,
  releaseClaim,
  type ReleaseClient,
  type SendCheckClient,
} from "@/lib/pitches/status-transitions";

// Conservative drip. pg_cron runs this every 10 minutes, 15:00-22:50 UTC on
// weekdays (`*/10 15-22 * * 1-5`, migration 0041), and each run sends at most
// one first email per inbox and SEND_PER_TICK in total: at most 6 per inbox
// per hour. The follow-up route runs 7 minutes after each of these runs (0052)
// under the same per-run limit, so an inbox never sends two emails within ~3
// minutes. The inbox daily_cap (slot RPC, 0049) is still the hard ceiling.
const SEND_PER_TICK = PER_RUN_TOTAL;
// Between sends of one run, which always come from different inboxes.
const JITTER_MS = 8_000;

/** A row left in 'sending' this long was interrupted mid-send (the route caps at 120s). */
const STUCK_SENDING_MS = 30 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

/**
 * Take a pitch that can never be sent out of the queue. Left 'approved', it
 * sat at the head of the FIFO window every day; 50 of them blocked the queue.
 */
async function dropFromQueue(supabase: AnySupabase, pitchId: string, reason: string): Promise<void> {
  await supabase
    .from("pitches")
    .update({ status: "auto_rejected", auto_rejected: true, auto_rejected_reason: reason })
    .eq("id", pitchId)
    .eq("status", "approved");
}

/**
 * Send it back to the drafts. Used when the quality gate holds an approved
 * pitch at send time: unlike a do-not-contact hit, that is fixable, so it goes
 * back where a person will see it (its gate verdict is already stored, and
 * /pitches shows the flags) instead of into auto_rejected.
 */
async function returnToDraft(supabase: AnySupabase, pitchId: string): Promise<void> {
  await supabase
    .from("pitches")
    .update({ status: "draft", scheduled_send_at: null, approved_at: null, gate_override: null })
    .eq("id", pitchId)
    .eq("status", "approved");
}

/**
 * Resolve rows stuck in 'sending' (the run died between claiming and saving).
 * Gmail's Sent folder decides: found → record it as sent; not found → it never
 * went out, so it goes back in the queue. Never guesses.
 */
async function recoverStuckSends(supabase: AnySupabase): Promise<SendOutcome[]> {
  const before = new Date(Date.now() - STUCK_SENDING_MS).toISOString();
  const { data: stuck } = await supabase
    .from("pitches")
    .select("id, subject, contact_id, sender_inbox_id, updated_at")
    .eq("status", "sending")
    .is("parent_pitch_id", null)
    .lt("updated_at", before)
    .limit(10);

  const out: SendOutcome[] = [];
  for (const row of (stuck ?? []) as Array<{
    id: string;
    subject: string;
    contact_id: string | null;
    sender_inbox_id: string | null;
    updated_at: string;
  }>) {
    const { data: inbox } = row.sender_inbox_id
      ? await supabase.from("sender_inboxes").select("gmail_refresh_token_encrypted").eq("id", row.sender_inbox_id).maybeSingle()
      : { data: null };
    const { data: contact } = row.contact_id
      ? await supabase.from("prospect_contacts").select("email").eq("id", row.contact_id).maybeSingle()
      : { data: null };
    if (!inbox?.gmail_refresh_token_encrypted || !contact?.email) {
      out.push({ pitch_id: row.id, status: "error", reason: "Stuck in 'sending' and can't be verified (no inbox or contact) — check by hand" });
      continue;
    }
    const tok = await getAccessToken(inbox.gmail_refresh_token_encrypted);
    if (!tok.ok) {
      out.push({ pitch_id: row.id, status: "error", reason: `Stuck in 'sending'; Gmail auth failed: ${tok.error}` });
      continue;
    }
    const found = await findSentMessage(tok.accessToken, {
      to: contact.email,
      subject: row.subject,
      afterEpochSec: Date.parse(row.updated_at) / 1000 - 24 * 60 * 60,
    });
    if (!found.ok) {
      out.push({ pitch_id: row.id, status: "error", reason: `Stuck in 'sending'; Sent lookup failed: ${found.error}` });
      continue;
    }
    if (found.found) {
      const sentAt = new Date(found.found.internalDate || Date.now());
      await supabase
        .from("pitches")
        .update({
          status: "sent",
          sent_at: sentAt.toISOString(),
          gmail_message_id: found.found.id,
          gmail_thread_id: found.found.threadId,
          sequence_step: 1,
          next_followup_at: new Date(sentAt.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .eq("id", row.id)
        .eq("status", "sending");
      out.push({ pitch_id: row.id, status: "sent", reason: "Recovered: it was in Gmail Sent" });
    } else {
      await supabase.from("pitches").update({ status: "approved" }).eq("id", row.id).eq("status", "sending");
      out.push({ pitch_id: row.id, status: "skipped", reason: "Recovered: never sent, back in the queue" });
    }
  }
  return out;
}

/** Vercel cron (CRON_SECRET) or the autopilot's pg_cron schedule (Vault token). */
function isAuthorized(req: NextRequest): Promise<boolean> {
  return isSchedulerAuthorized(req);
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
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return withHeartbeat("send-queue", () => runSendQueue());
}

/** One authorized run (its heartbeat is written by GET). */
async function runSendQueue() {
  const startMs = Date.now();
  const supabase = createServiceRoleClient() as AnySupabase;
  const slots = supabase as SlotClient;
  const nowIso = new Date().toISOString();
  const results: SendOutcome[] = [];

  // Inbox cache for THIS tick. `remaining` only skips work early; the slot
  // RPC (migration 0049) is what enforces daily_cap, across overlapping runs.
  const inboxCache = new Map<
    string,
    {
      email: string;
      display_name: string;
      token: string | null;
      paused: boolean;
      remaining: number; // daily_cap - sends_today at first read; 0 once the slot RPC says the cap is reached
      bounceBlock?: string | null; // undefined = not checked yet this run; string = skip reason
    }
  >();

  try {
    results.push(...(await recoverStuckSends(supabase)));

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
    const pacer = createRunPacer({ perInbox: 1, total: SEND_PER_TICK });

    for (const pitch of duePitches) {
      // One pitch failing (network, Gmail) must not abort the rest of the run.
      // A throw after the claim leaves the row in 'sending'; recoverStuckSends
      // resolves it on the next run from Gmail's Sent folder.
      try {
        // Pacing first, before any read or claim: a pitch over the limit stays
        // 'approved' as it is, for the next run.
        const pace = pacer.check(pitch.sender_inbox_id);
        if (!pace.ok) {
          results.push({ pitch_id: pitch.id, status: "skipped", reason: pace.reason });
          if (pace.stop) break;
          continue;
        }
        // Time budget: what's left is picked up by the next run (every 10 min).
        if (!hasTimeToClaim(startMs)) {
          results.push({ pitch_id: pitch.id, status: "skipped", reason: "Time budget reached — next run" });
          break;
        }
        if (!pitch.sender_inbox_id) {
          results.push({ pitch_id: pitch.id, status: "skipped", reason: "No sender inbox" });
          continue;
        }

        // ── Resolve + cache the inbox budget ────────────────────────────────
        let inbox = inboxCache.get(pitch.sender_inbox_id);
        if (!inbox) {
          const { data: row } = await supabase
            .from("sender_inboxes")
            .select("id, email, display_name, daily_cap, sends_today, last_reset_date, paused, gmail_refresh_token_encrypted")
            .eq("id", pitch.sender_inbox_id)
            .maybeSingle();
          if (!row) {
            results.push({ pitch_id: pitch.id, status: "skipped", reason: "Inbox not found" });
            continue;
          }
          // Daily cap resets at the UTC day boundary — ignore yesterday's count.
          const sentToday = effectiveSendsToday(row.sends_today ?? 0, row.last_reset_date);
          inbox = {
            email: row.email,
            display_name: row.display_name,
            token: row.gmail_refresh_token_encrypted,
            paused: row.paused,
            remaining: Math.max(0, (row.daily_cap ?? 0) - sentToday),
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

        // ── Bounce breaker: the tick's inbox_bounces rule, before the first send ─
        // On 2026-10-19, 13 emails went out after two bounces were already in
        // Gmail. The reply poll runs 5 minutes after each send run (0048), so a
        // fresh bounce stops the rest of the drip. Skip only: the next tick
        // pauses the inbox and emails. Checked once per inbox per run.
        if (inbox.bounceBlock === undefined) {
          const block = await inboxBounceBlock(supabase, pitch.tenant_id, pitch.sender_inbox_id);
          inbox.bounceBlock = block.blocked ? block.reason : null;
        }
        if (inbox.bounceBlock) {
          results.push({ pitch_id: pitch.id, status: "skipped", reason: inbox.bounceBlock });
          continue;
        }

        // ── Prospect must still be sendable ─────────────────────────────────
        // A prospect can be suppressed/lost/booked AFTER its pitch was queued;
        // without this check the cron would still email them. Fails closed: an
        // unreadable prospect is skipped (kept queued), never sent or dropped.
        const { data: prospectRow, error: prospectErr } = await supabase
          .from("prospects")
          .select("status, cooldown_until, language, domain")
          .eq("id", pitch.prospect_id)
          .maybeSingle();
        const prospectBlock = prospectSendBlock(prospectRow, prospectErr, nowIso);
        if (prospectBlock) {
          if (prospectBlock.kind === "do_not_send") await dropFromQueue(supabase, pitch.id, prospectBlock.reason);
          results.push({ pitch_id: pitch.id, status: "skipped", reason: prospectBlock.reason });
          continue;
        }

        // ── Resolve the contact email ───────────────────────────────────────
        if (!pitch.contact_id) {
          results.push({ pitch_id: pitch.id, status: "skipped", reason: "No contact" });
          continue;
        }
        const { data: contact } = await supabase
          .from("prospect_contacts")
          .select("email, full_name, selected_by")
          .eq("id", pitch.contact_id)
          .maybeSingle();
        const toEmail: string | null = contact?.email ?? null;
        if (!toEmail) {
          results.push({ pitch_id: pitch.id, status: "skipped", reason: "Contact has no email" });
          continue;
        }
        // Same gate the manual send path uses — junk contacts linked before the
        // validation hardening must never be emailed.
        if (!hasUsableEmail(toEmail)) {
          await dropFromQueue(supabase, pitch.id, `Unusable email: ${toEmail}`);
          results.push({ pitch_id: pitch.id, status: "skipped", reason: `Unusable email: ${toEmail}` });
          continue;
        }
        // Per-ADDRESS suppression (bounced mailboxes, existing clients,
        // competitors) — catches an address that lives on a duplicate prospect
        // row the prospect-level status check can't see.
        const dnc = await isEmailOnDncList(supabase as unknown as DncClient, pitch.tenant_id, toEmail);
        if (dnc.blocked) {
          await dropFromQueue(supabase, pitch.id, dnc.reason);
          results.push({ pitch_id: pitch.id, status: "skipped", reason: dnc.reason });
          continue;
        }
        // One first email per prospect and per address — a regenerated draft or
        // a duplicate prospect row must not produce a second.
        const duplicate = await firstTouchConflict(supabase, {
          tenantId: pitch.tenant_id,
          prospectId: pitch.prospect_id,
          pitchId: pitch.id,
          email: toEmail,
        });
        if (duplicate) {
          await dropFromQueue(supabase, pitch.id, duplicate);
          results.push({ pitch_id: pitch.id, status: "skipped", reason: duplicate });
          continue;
        }
        // SPAM Verify: an address that can only bounce, or must never be
        // pitched, leaves the queue. "review" sends when a person approved it
        // (their call); when the autopilot approved it, the address became
        // doubtful after approval, so it goes back to a person instead.
        const verify = await verifyRecipient(supabase, {
          tenantId: pitch.tenant_id,
          email: toEmail,
          selectedBy: contact?.selected_by ?? null,
          prospectDomain: prospectRow?.domain ?? null,
        });
        const approval = verify.verdict === "review" ? await latestApproval(supabase, pitch.tenant_id, pitch.id) : null;
        const verdictAction = sendTimeVerdictAction(verify.verdict, approval);
        if (verdictAction === "drop") {
          const reason = `SPAM Verify: ${verify.reasons.join("; ")}`;
          await dropFromQueue(supabase, pitch.id, reason);
          results.push({ pitch_id: pitch.id, status: "skipped", reason });
          continue;
        }
        if (verdictAction === "skip") {
          results.push({ pitch_id: pitch.id, status: "skipped", reason: "Couldn't read who approved it (address needs review) — not sent" });
          continue;
        }
        if (verdictAction === "hold") {
          const why = `SPAM Verify review: ${verify.reasons.join("; ")}`;
          const moved = await holdDoubtfulAutoApproval(supabase, { tenantId: pitch.tenant_id, pitchId: pitch.id, why });
          results.push({
            pitch_id: pitch.id,
            status: "skipped",
            reason: moved ? `Back to review — ${why}` : `Not sent (${why}); it was no longer approved, left as is`,
          });
          continue;
        }
        const body = (pitch.body_edited ?? pitch.body_original ?? "").trim();
        if (!body) {
          results.push({ pitch_id: pitch.id, status: "skipped", reason: "Empty body" });
          continue;
        }

        // CASL footer + unsubscribe link. Fails closed: no mailing address, no send.
        const lang: "en" | "es" = prospectRow?.language === "es" ? "es" : "en";
        // A draft from before the Nils/Henry switch still ends "Pedro"; match the From line.
        const signedBody = reconcileSignOff(body, lang);
        const compliance = getOutboundCompliance({
          tenantId: pitch.tenant_id,
          prospectId: pitch.prospect_id,
          email: toEmail,
          lang,
        });
        if (!compliance.ok) {
          results.push({ pitch_id: pitch.id, status: "skipped", reason: compliance.error });
          continue;
        }

        // Send gate v2, on the exact text and address going out. Approval
        // checked the draft; since then the contact may have changed or the
        // body been edited. Block-level failures, or review-level ones nobody
        // accepted, take it out of the queue with the reasons. If the check
        // can't run, it stays queued and is not sent (fails closed).
        const gate = await checkPitchGate(supabase, pitch.tenant_id, pitch.id, {
          body: signedBody,
          recipient: { email: toEmail, full_name: contact?.full_name ?? null, selected_by: contact?.selected_by ?? null },
        });
        if (!gate) {
          results.push({ pitch_id: pitch.id, status: "skipped", reason: "Quality gate unavailable — not sent" });
          continue;
        }
        const allowed = gateAllows(gate.result, gate.override?.codes);
        if (!allowed.ok) {
          const reason = `Quality gate: ${describeFailures(allowed.outstanding)}`.slice(0, 1000);
          await returnToDraft(supabase, pitch.id);
          await auditGateHold({
            tenantId: pitch.tenant_id,
            actorId: null,
            pitchId: pitch.id,
            path: "send-queue",
            failures: allowed.outstanding,
          });
          await recordPitchEvent(supabase, {
            tenantId: pitch.tenant_id,
            pitchId: pitch.id,
            type: "gate_held",
            payload: { path: "send-queue", codes: allowed.outstanding.map((f) => f.code) },
          });
          results.push({ pitch_id: pitch.id, status: "skipped", reason });
          continue;
        }

        // The checks above take seconds each: re-check the budget at the claim.
        if (!hasTimeToClaim(startMs)) {
          results.push({ pitch_id: pitch.id, status: "skipped", reason: "Time budget reached — next run" });
          break;
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

        // ── Take a daily slot (one SQL statement; overlapping runs can't over-send) ─
        const releaser = supabase as unknown as ReleaseClient;
        const inboxId = pitch.sender_inbox_id;
        const slot = await reserveSendSlot(slots, inboxId);
        if (!slot.ok) {
          await releaseClaim(releaser, { pitchId: pitch.id, to: "approved" });
          if (slot.capReached) inbox.remaining = 0;
          results.push({ pitch_id: pitch.id, status: "skipped", reason: slot.reason });
          continue;
        }
        // From here, every exit where Gmail did not take the message gives back
        // the slot AND the claim.

        // ── Send ─────────────────────────────────────────────────────────────
        const tokenResult = await getAccessToken(inbox.token);
        if (!tokenResult.ok) {
          await releaseSendSlot(slots, inboxId, slot.day);
          await releaseClaim(releaser, { pitchId: pitch.id, to: "approved" });
          results.push({ pitch_id: pitch.id, status: "error", reason: `Auth: ${tokenResult.error}` });
          continue;
        }

        if (pacer.sent > 0) {
          await new Promise((r) => setTimeout(r, Math.random() * JITTER_MS));
        }

        // ── Last moment: may this prospect still be emailed? ─────────────────
        // Everything above (DNS verify, gate, token, jitter) takes seconds; an
        // opt-out the reply poll records meanwhile must stop this send.
        const lastCheck = await recheckBeforeSend(supabase as unknown as SendCheckClient, {
          tenantId: pitch.tenant_id,
          prospectId: pitch.prospect_id,
          email: toEmail,
        });
        if (lastCheck) {
          await releaseSendSlot(slots, inboxId, slot.day);
          await releaseClaim(releaser, { pitchId: pitch.id, ...queueReleaseFor(lastCheck) });
          results.push({ pitch_id: pitch.id, status: "skipped", reason: lastCheck.reason });
          continue;
        }

        const toName = contact?.full_name ?? null;
        const sendResult = await sendGmailMessage({
          accessToken: tokenResult.accessToken,
          fromEmail: inbox.email,
          fromName: senderIdentity(lang).displayName,
          to: toName ? `"${String(toName).replace(/"/g, "")}" <${toEmail}>` : toEmail,
          subject: pitch.subject,
          body: signedBody,
          lang,
          footer: compliance.value.footer,
          listUnsubscribe: compliance.value.listUnsubscribe,
        });

        if (!sendResult.ok) {
          await releaseSendSlot(slots, inboxId, slot.day);
          await releaseClaim(releaser, { pitchId: pitch.id, to: "approved" });
          await recordSendFailure(supabase, { tenantId: pitch.tenant_id, inboxId, pitchId: pitch.id, error: sendResult.error });
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
            body_sent: bodyWithFooter(signedBody, compliance.value.footer),
            gmail_message_id: sendResult.gmailMessageId,
            gmail_thread_id: sendResult.threadId ?? null,
            sequence_step: 1,
            next_followup_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          })
          .eq("id", pitch.id);

        // (The send was counted when its slot was reserved.)

        await recordPitchEvent(supabase, {
          tenantId: pitch.tenant_id,
          pitchId: pitch.id,
          type: "sent",
          payload: {
            path: "send-queue",
            step: 1,
            lang,
            recipient_domain: toEmail.split("@")[1]?.toLowerCase() ?? null,
            recipient_source: contact?.selected_by ?? null,
            verify_verdict: verify.verdict,
            gate_version: gate.verdict.version,
            gate_accepted: gate.override?.codes ?? [],
            // How much a person changed the AI's draft before it went out.
            edit_ratio: editRatio(pitch.body_original ?? "", signedBody),
          },
        });

        pacer.recordSent(inboxId);
        results.push({ pitch_id: pitch.id, status: "sent" });
      } catch (err) {
        // Can't tell whether Gmail took it before the throw: count it (fails closed).
        if (pitch.sender_inbox_id) pacer.recordSent(pitch.sender_inbox_id);
        results.push({ pitch_id: pitch.id, status: "error", reason: err instanceof Error ? err.message : String(err) });
      }
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
