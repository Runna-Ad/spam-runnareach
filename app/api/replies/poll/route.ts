// ─────────────────────────────────────────────────────────────────────────────
// app/api/replies/poll/route.ts
//
// Reply-funnel ingestion cron — pulls prospect replies OUT of Gmail INTO /inbox.
//
// Per tick:
//   1. Find sent pitches that have a gmail_thread_id and a live prospect
//      (not booked / suppressed / archived). Dedupe to one row per thread.
//   2. For each thread: mint an access token for its sender inbox, fetch the
//      thread via the Gmail API, and collect inbound messages (from the
//      prospect, not us) that we haven't imported yet.
//   3. Insert each new reply, classify intent (Claude → heuristic fallback),
//      pause the follow-up sequence, and mark the prospect 'replied'.
//   4. Draft a response (Claude → heuristic) for engageable intents when the
//      prospect is still under the 3-reply cap → draft_status='pending'.
//      If the prospect is already at the cap and still hasn't booked, archive
//      it as archived_no_meeting with a captured learning.
//   5. Email Pedro a digest of drafts awaiting review (in-app + email alert).
//
// Auth: Authorization: Bearer <CRON_SECRET>.
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import { fetchThreadReplies, type InboundReply } from "@/lib/gmail/read";
import {
  ANTHROPIC_HAIKU_MODEL,
  claudeIsAvailable,
} from "@/lib/anthropic/client";
import { recordClaudeCall } from "@/lib/anthropic/cost-tracking";
import { classifyReplyWithClaude } from "@/lib/replies/claude-classifier";
import { classifyReplyHeuristic, type ClassifyResult } from "@/lib/replies/classify";
import {
  composeReplyDraftHeuristic,
  composeReplyDraftWithClaude,
  type DraftComposerInput,
} from "@/lib/replies/draft-composer";
import type { ReplyIntent } from "@/lib/replies/queries";
import { addEmailToDnc, type DncInsertClient } from "@/lib/discover/dnc-check";
import { extractBouncedRecipient } from "@/lib/replies/bounce-parse";

const MAX_REPLY_ATTEMPTS = 3;
// Intents we draft a response for. Negatives (hard_no / wrong_person) and
// auto_reply are left for Pedro's intent actions in /inbox — no draft.
const DRAFTABLE: ReplyIntent[] = ["wants_meeting", "wants_info", "not_now", "unclassified"];
// Prospect statuses that are terminal for the funnel — skip their threads.
const DEAD_STATUSES = new Set(["booked", "suppressed", "archived_no_meeting", "won", "lost"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

type ThreadRow = {
  pitch_id: string;
  tenant_id: string;
  prospect_id: string;
  contact_id: string | null;
  sender_inbox_id: string | null;
  subject: string;
  gmail_thread_id: string;
  sent_at: string | null;
};

type DraftDigestItem = { prospect: string; intent: ReplyIntent };

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const supabase = createServiceRoleClient() as AnySupabase;

  // ── 1. Find candidate threads ────────────────────────────────────────────
  const { data: pitchRows, error: pitchErr } = await supabase
    .from("pitches")
    .select(
      "id, tenant_id, prospect_id, contact_id, sender_inbox_id, subject, gmail_thread_id, sent_at",
    )
    .eq("status", "sent")
    .not("gmail_thread_id", "is", null)
    .order("sent_at", { ascending: false })
    .limit(500);

  if (pitchErr) {
    console.error("[replies/poll] pitch query failed:", pitchErr.message);
    return NextResponse.json({ error: "DB query failed", details: pitchErr.message }, { status: 500 });
  }

  // Dedupe to one (most recent) pitch per thread.
  const threadMap = new Map<string, ThreadRow>();
  for (const p of (pitchRows ?? []) as Array<ThreadRow & { id: string }>) {
    const key = p.gmail_thread_id;
    if (!key) continue;
    if (!threadMap.has(key)) {
      threadMap.set(key, {
        pitch_id: p.id,
        tenant_id: p.tenant_id,
        prospect_id: p.prospect_id,
        contact_id: p.contact_id,
        sender_inbox_id: p.sender_inbox_id,
        subject: p.subject,
        gmail_thread_id: p.gmail_thread_id,
        sent_at: p.sent_at,
      });
    }
  }

  // Token cache per inbox (id → { email, token }).
  const inboxCache = new Map<string, { email: string; display_name: string; token: string } | null>();
  // Per-tenant digest of drafts created this run, for the email alert.
  const digest = new Map<string, DraftDigestItem[]>();

  let imported = 0;
  let drafted = 0;
  let archived = 0;
  const errors: string[] = [];

  for (const thread of threadMap.values()) {
    try {
      if (!thread.sender_inbox_id) continue;

      // ── Resolve the prospect (skip dead funnel states) ──────────────────
      const { data: prospect } = await supabase
        .from("prospects")
        .select("id, company_name, language, status, reply_attempts")
        .eq("id", thread.prospect_id)
        .maybeSingle();
      if (!prospect) continue;
      if (DEAD_STATUSES.has(prospect.status)) continue;

      // ── Resolve + cache the sender inbox token ──────────────────────────
      let inbox = inboxCache.get(thread.sender_inbox_id);
      if (inbox === undefined) {
        const { data: row } = await supabase
          .from("sender_inboxes")
          .select("email, display_name, gmail_refresh_token_encrypted")
          .eq("id", thread.sender_inbox_id)
          .maybeSingle();
        if (!row?.gmail_refresh_token_encrypted) {
          inboxCache.set(thread.sender_inbox_id, null);
          inbox = null;
        } else {
          const tok = await getAccessToken(row.gmail_refresh_token_encrypted);
          inbox = tok.ok
            ? { email: row.email, display_name: row.display_name, token: tok.accessToken }
            : null;
          inboxCache.set(thread.sender_inbox_id, inbox);
        }
      }
      if (!inbox) continue;

      // ── Fetch the thread + find inbound replies ─────────────────────────
      const fetched = await fetchThreadReplies(inbox.token, thread.gmail_thread_id, [inbox.email]);
      if (!fetched.ok) {
        errors.push(`thread ${thread.gmail_thread_id}: ${fetched.error}`);
        continue;
      }
      if (fetched.replies.length === 0) continue;

      // Dedupe against already-imported messages for this prospect.
      const candidateIds = fetched.replies.map((r) => r.gmailMessageId);
      const { data: existing } = await supabase
        .from("replies")
        .select("gmail_message_id")
        .eq("tenant_id", thread.tenant_id)
        .in("gmail_message_id", candidateIds);
      const seen = new Set((existing ?? []).map((e: { gmail_message_id: string }) => e.gmail_message_id));

      // Only messages received after our pitch went out, and not yet imported.
      const sentMs = thread.sent_at ? Date.parse(thread.sent_at) : 0;
      const fresh = fetched.replies
        .filter((r) => !seen.has(r.gmailMessageId))
        .filter((r) => r.internalDate >= sentMs - 60_000) // small clock-skew grace
        .sort((a, b) => a.internalDate - b.internalDate);
      if (fresh.length === 0) continue;

      const replyAttempts: number = prospect.reply_attempts ?? 0;

      for (const inbound of fresh) {
        const classification = await classifyReply(supabase, thread.tenant_id, inbound);

        // Insert the reply row.
        const { data: insertedReply } = await supabase
          .from("replies")
          .insert({
            tenant_id: thread.tenant_id,
            pitch_id: thread.pitch_id,
            prospect_id: thread.prospect_id,
            gmail_message_id: inbound.gmailMessageId,
            gmail_rfc_message_id: inbound.rfcMessageId,
            from_email: inbound.fromEmail,
            subject: inbound.subject,
            body_text: inbound.bodyText,
            received_at: new Date(inbound.internalDate || Date.now()).toISOString(),
            intent: classification.intent,
            urgency: classification.urgency,
            sentiment: classification.sentiment,
            classified_at: new Date().toISOString(),
            draft_thread_id: thread.gmail_thread_id,
          })
          .select("id")
          .maybeSingle();

        if (!insertedReply) continue;
        imported += 1;

        await supabase.from("audit_log").insert({
          tenant_id: thread.tenant_id,
          actor_id: null,
          action: "reply.imported",
          entity_type: "reply",
          entity_id: insertedReply.id,
          metadata: {
            prospect_id: thread.prospect_id,
            from: inbound.fromEmail,
            intent: classification.intent,
            source: "gmail_poll",
          },
        });

        // ── Bounce (NDR) → auto-suppress immediately ───────────────────────
        // A daemon NDR means the address is dead. Waiting for a human to click
        // "Suppress" leaves the prospect active — follow-ups kept firing at
        // dead mailboxes, and the generic path below even marked the prospect
        // "replied" (a bounce is not engagement). Suppress now; the inbox item
        // stays visible for review with the suppression already applied.
        if (classification.intent === "bounced") {
          // Block the ADDRESS, not just this prospect — the same mailbox can
          // sit on a duplicate prospect row and would otherwise be emailed
          // again. Only block an address the NDR positively names: guessing
          // wrong would permanently silence a perfectly good contact. If it
          // can't be parsed, prospect-level suppression below still applies.
          const deadAddress = extractBouncedRecipient(inbound.bodyText, inbox.email);
          if (deadAddress) {
            await addEmailToDnc(
              supabase as unknown as DncInsertClient,
              thread.tenant_id,
              deadAddress,
              "bounced",
              `Auto-added ${new Date().toISOString().slice(0, 10)}: hard bounce (undeliverable).`,
            );
          }
          await supabase
            .from("prospects")
            .update({
              status: "suppressed",
              suppressed_at: new Date().toISOString(),
              suppressed_reason: "Email bounced (undeliverable) — auto-suppressed",
              cooldown_until: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            })
            .eq("id", thread.prospect_id);
          await pauseSequence(supabase, thread.tenant_id, thread.prospect_id);
          await supabase.from("audit_log").insert({
            tenant_id: thread.tenant_id,
            actor_id: null,
            action: "prospect.suppressed",
            entity_type: "prospect",
            entity_id: thread.prospect_id,
            metadata: { reply_id: insertedReply.id, reason: "bounced_auto", source: "gmail_poll" },
          });
          continue;
        }

        // ── Cap reached + not booked + still negotiating → archive ─────────
        if (replyAttempts >= MAX_REPLY_ATTEMPTS && classification.intent !== "wants_meeting") {
          const reason =
            `Archived after ${replyAttempts} funnel replies without booking. ` +
            `Last intent: ${classification.intent}. ` +
            `Last message: "${(inbound.bodyText ?? "").slice(0, 160).replace(/\s+/g, " ").trim()}"`;
          await supabase
            .from("prospects")
            .update({
              status: "archived_no_meeting",
              no_meeting_reason: reason,
              archived_at: new Date().toISOString(),
            })
            .eq("id", thread.prospect_id);
          await pauseSequence(supabase, thread.tenant_id, thread.prospect_id);
          await supabase.from("audit_log").insert({
            tenant_id: thread.tenant_id,
            actor_id: null,
            action: "prospect.archived_no_meeting",
            entity_type: "prospect",
            entity_id: thread.prospect_id,
            metadata: { reply_id: insertedReply.id, reason, source: "gmail_poll" },
          });
          archived += 1;
          continue;
        }

        // ── Draft a response for engageable intents ────────────────────────
        if (DRAFTABLE.includes(classification.intent)) {
          const draft = await draftResponse(
            supabase,
            thread,
            prospect,
            inbound,
            classification.intent,
            inbox.display_name,
          );
          if (draft) {
            await supabase
              .from("replies")
              .update({
                auto_draft_body: draft.body,
                draft_subject: draft.subject,
                draft_status: "pending",
                draft_model: draft.model,
                draft_cost_usd: draft.cost_usd,
                auto_draft_generated_at: new Date().toISOString(),
              })
              .eq("id", insertedReply.id);
            drafted += 1;
            const list = digest.get(thread.tenant_id) ?? [];
            list.push({ prospect: prospect.company_name, intent: classification.intent });
            digest.set(thread.tenant_id, list);
            await supabase.from("audit_log").insert({
              tenant_id: thread.tenant_id,
              actor_id: null,
              action: "reply.drafted",
              entity_type: "reply",
              entity_id: insertedReply.id,
              metadata: { prospect_id: thread.prospect_id, intent: classification.intent, model: draft.model },
            });
          }
        }
      }

      // Pause the follow-up sequence + mark prospect 'replied' (non-terminal).
      await pauseSequence(supabase, thread.tenant_id, thread.prospect_id);
      if (!DEAD_STATUSES.has(prospect.status)) {
        await supabase
          .from("prospects")
          .update({ status: "replied" })
          .eq("id", thread.prospect_id)
          .neq("status", "archived_no_meeting");
      }
    } catch (err) {
      console.error(`[replies/poll] thread ${thread.gmail_thread_id} error:`, err);
      errors.push(`thread ${thread.gmail_thread_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 5. Email Pedro a digest of new drafts awaiting review ─────────────────
  if (drafted > 0) {
    await sendDraftDigest(supabase, inboxCache, digest).catch((e) =>
      console.error("[replies/poll] digest email failed:", e),
    );
  }

  return NextResponse.json({
    ok: true,
    duration_ms: Date.now() - startTime,
    threads_scanned: threadMap.size,
    imported,
    drafted,
    archived,
    errors,
  });
}

// ── Classify (Claude → heuristic) ──────────────────────────────────────────────

async function classifyReply(
  supabase: AnySupabase,
  tenantId: string,
  inbound: InboundReply,
): Promise<ClassifyResult> {
  const input = {
    subject: inbound.subject,
    body_text: inbound.bodyText,
    from_email: inbound.fromEmail,
  };
  if (!claudeIsAvailable()) return classifyReplyHeuristic(input);

  const result = await classifyReplyWithClaude(input);
  if (result.ok) {
    await recordClaudeCall({
      tenantId,
      model: result.result.model,
      entity_type: "reply_classify",
      entity_id: null,
      usage: result.result.usage,
      metadata: { from: inbound.fromEmail, intent: result.result.classification.intent, source: "gmail_poll" },
    });
    return result.result.classification;
  }
  if (result.usage) {
    await recordClaudeCall({
      tenantId,
      model: ANTHROPIC_HAIKU_MODEL,
      entity_type: "reply_classify",
      entity_id: null,
      usage: result.usage,
      metadata: { from: inbound.fromEmail, fallback_reason: result.reason },
    });
  }
  return classifyReplyHeuristic(input);
}

// ── Draft (Claude → heuristic) ─────────────────────────────────────────────────

async function draftResponse(
  supabase: AnySupabase,
  thread: ThreadRow,
  prospect: { company_name: string; language: string },
  inbound: InboundReply,
  intent: ReplyIntent,
  senderDisplayName: string,
): Promise<{ body: string; subject: string; model: string; cost_usd: number | null } | null> {
  const language: "en" | "es" = prospect.language === "es" ? "es" : "en";
  const senderFirstName = senderDisplayName.trim().split(/\s+/)[0] || "Pedro";

  // Best-effort contact first name from the thread reply.
  const contactFirstName = inbound.fromName?.trim().split(/\s+/)[0] ?? null;

  // Pull the original pitch we sent + research so the reply can actually speak to
  // what they're asking about instead of deflecting to "let's book a call".
  let originalPitchBody: string | null = null;
  let whatTheyDo: string | null = null;
  let painSummary: string | null = null;
  try {
    const { data: pitch } = await supabase
      .from("pitches")
      .select("body_edited, body_original")
      .eq("prospect_id", thread.prospect_id)
      .eq("tenant_id", thread.tenant_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    originalPitchBody = pitch?.body_edited ?? pitch?.body_original ?? null;

    // prospect_research is the table every writer uses (the legacy "research"
    // table this used to read is never written — drafts ran without context).
    const { data: research } = await supabase
      .from("prospect_research")
      .select("what_they_do, pain_points")
      .eq("prospect_id", thread.prospect_id)
      .maybeSingle();
    whatTheyDo = research?.what_they_do ?? null;
    const pains = Array.isArray(research?.pain_points) ? research.pain_points : [];
    painSummary =
      (pains[0] as { pain_label?: string } | undefined)?.pain_label ?? null;
  } catch {
    // Best-effort context — the composer still works without it.
  }

  const draftInput: DraftComposerInput = {
    contactFirstName,
    companyName: prospect.company_name,
    language,
    intent,
    replySubject: inbound.subject,
    replyBody: inbound.bodyText,
    threadSubject: thread.subject,
    originalPitchBody,
    whatTheyDo,
    painSummary,
    senderFirstName,
    agencyName: "Runna",
  };

  if (claudeIsAvailable()) {
    const result = await composeReplyDraftWithClaude(draftInput);
    if (result.ok) {
      await recordClaudeCall({
        tenantId: thread.tenant_id,
        model: result.model,
        entity_type: "reply_draft",
        entity_id: null,
        usage: result.usage,
        metadata: { prospect_id: thread.prospect_id, intent, source: "gmail_poll" },
      });
      return { body: result.draft.body, subject: result.draft.subject, model: result.model, cost_usd: result.usage.cost_usd };
    }
    if (result.usage) {
      await recordClaudeCall({
        tenantId: thread.tenant_id,
        model: result.usage ? "claude-sonnet-4-5-20250929" : "unknown",
        entity_type: "reply_draft",
        entity_id: null,
        usage: result.usage,
        metadata: { prospect_id: thread.prospect_id, fallback_reason: result.reason },
      });
    }
  }

  const fallback = composeReplyDraftHeuristic(draftInput);
  return { body: fallback.body, subject: fallback.subject, model: "heuristic", cost_usd: null };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function pauseSequence(supabase: AnySupabase, tenantId: string, prospectId: string): Promise<void> {
  await supabase
    .from("pitches")
    .update({ sequence_paused_at: new Date().toISOString() })
    .eq("prospect_id", prospectId)
    .eq("tenant_id", tenantId)
    .eq("status", "sent")
    .is("sequence_paused_at", null);
}

async function sendDraftDigest(
  supabase: AnySupabase,
  inboxCache: Map<string, { email: string; display_name: string; token: string } | null>,
  digest: Map<string, DraftDigestItem[]>,
): Promise<void> {
  const notifyTo = process.env.REPLY_FUNNEL_NOTIFY_EMAIL || "petedv31@gmail.com";
  // Use any connected inbox we already have a token for as the sender.
  const sender = [...inboxCache.values()].find((i): i is { email: string; display_name: string; token: string } => i !== null);
  if (!sender) return;

  for (const items of digest.values()) {
    if (items.length === 0) continue;
    const lines = items.map((i) => `• ${i.prospect} — ${i.intent.replace(/_/g, " ")}`).join("\n");
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://spam-runnareach.vercel.app";
    const body =
      `${items.length} new repl${items.length === 1 ? "y" : "ies"} drafted and waiting for your review.\n\n` +
      `${lines}\n\n` +
      `Review + approve in the inbox:\n${appUrl}/inbox`;
    await sendGmailMessage({
      accessToken: sender.token,
      fromEmail: sender.email,
      fromName: "S.P.A.M Reply Funnel",
      to: notifyTo,
      subject: `${items.length} reply draft${items.length === 1 ? "" : "s"} awaiting review`,
      body,
    });
  }
}
