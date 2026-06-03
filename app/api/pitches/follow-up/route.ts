// ─────────────────────────────────────────────────────────────────────────────
// app/api/pitches/follow-up/route.ts
//
// Follow-up sequence cron — triggered daily at 4pm UTC by Vercel Cron.
//
// Logic per tick:
//   1. Find all sent pitches with next_followup_at <= now, sequence_step < 3,
//      and sequence_paused_at IS NULL.
//   2. For each due pitch: load prospect + contact + research (for pain) +
//      sender inbox.
//   3. Build the correct follow-up template (step 2 = soft check-in,
//      step 3 = final + coffee offer).
//   4. Send via Gmail in the original thread (In-Reply-To + threadId).
//   5. Insert a new pitch row for the follow-up step.
//   6. Update original pitch: clear next_followup_at (final) or advance it +5d.
//   7. Log to audit_log.
//
// Auth: Authorization: Bearer <CRON_SECRET> header.
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import {
  buildFollowup1,
  buildFollowup2,
  type FollowupContext,
} from "@/lib/pitches/followup-templates";

// ── Auth guard ─────────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

// ── DB row types ──────────────────────────────────────────────────────────────

type DuePitchRow = {
  id: string;
  tenant_id: string;
  prospect_id: string;
  contact_id: string | null;
  sender_inbox_id: string | null;
  subject: string;
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
  sequence_step: number;
  case_study_id: string;
  service_id: string | null;
  pain_id: string | null;
};

type ProspectRow = {
  id: string;
  company_name: string;
  market: string;
};

type ContactRow = {
  id: string;
  email: string | null;
  full_name: string | null;
};

type ResearchRow = {
  pain_points: Array<{ pain_code: string; quote?: string }> | null;
};

type InboxRow = {
  id: string;
  email: string;
  display_name: string;
  gmail_refresh_token_encrypted: string | null;
  paused: boolean;
  sends_today: number;
  daily_cap: number;
};

type FollowupResult = {
  pitch_id: string;
  prospect: string;
  step: number;
  status: "sent" | "skipped";
  reason?: string;
};

// ── Resolve market type safely ────────────────────────────────────────────────

function resolveMarket(raw: string): "CA" | "MX" {
  const upper = raw.toUpperCase();
  if (upper === "MX") return "MX";
  return "CA"; // default to CA for any other value (US, LATAM, etc.)
}

// ── Process a single due pitch ─────────────────────────────────────────────────

async function processFollowup(pitch: DuePitchRow): Promise<FollowupResult> {
  const supabase = createServiceRoleClient();
  const nextStep = pitch.sequence_step + 1; // 2 or 3

  // ── 1. Load prospect ──────────────────────────────────────────────────────
  const { data: prospect } = await supabase
    .from("prospects")
    .select("id, company_name, market")
    .eq("id", pitch.prospect_id)
    .maybeSingle<ProspectRow>();

  if (!prospect) {
    return { pitch_id: pitch.id, prospect: "unknown", step: nextStep, status: "skipped", reason: "Prospect not found" };
  }

  // ── 2. Load contact ───────────────────────────────────────────────────────
  let contactEmail: string | null = null;
  let contactFirstName: string | null = null;

  if (pitch.contact_id) {
    const { data: contact } = await supabase
      .from("prospect_contacts")
      .select("id, email, full_name")
      .eq("id", pitch.contact_id)
      .maybeSingle<ContactRow>();

    if (contact) {
      contactEmail = contact.email;
      // Extract first name from full name
      if (contact.full_name) {
        contactFirstName = contact.full_name.trim().split(/\s+/)[0] ?? null;
      }
    }
  }

  if (!contactEmail) {
    return { pitch_id: pitch.id, prospect: prospect.company_name, step: nextStep, status: "skipped", reason: "No contact email" };
  }

  // ── 3. Load research for pain summary ─────────────────────────────────────
  let painSummary: string | null = null;

  // research table not yet in generated types — cast to any for raw access
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: research } = await (supabase as any)
    .from("research")
    .select("pain_points")
    .eq("prospect_id", pitch.prospect_id)
    .is("superseded_at", null)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle() as { data: ResearchRow | null };

  if (research?.pain_points && research.pain_points.length > 0) {
    // Use the quote from the first pain point as a one-liner, if available
    const firstPain = research.pain_points[0];
    if (firstPain?.quote) {
      // Trim to a concise phrase — max 80 chars
      painSummary = firstPain.quote.slice(0, 80).replace(/\.$/, "");
    }
  }

  // ── 4. Load hunter scan value for this prospect's website ─────────────────
  let hunterValue: number | null = null;

  const { data: prospectFull } = await supabase
    .from("prospects")
    .select("website_url")
    .eq("id", pitch.prospect_id)
    .maybeSingle<{ website_url: string | null }>();

  if (prospectFull?.website_url) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: scan } = await (supabase as any)
      .from("hunter_scans")
      .select("results")
      .eq("website_url", prospectFull.website_url)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle() as { data: { results: { total?: number } | null } | null };

    if (scan?.results?.total && scan.results.total > 0) {
      hunterValue = scan.results.total;
    }
  }

  // ── 5. Load sender inbox ──────────────────────────────────────────────────
  if (!pitch.sender_inbox_id) {
    return { pitch_id: pitch.id, prospect: prospect.company_name, step: nextStep, status: "skipped", reason: "No sender inbox on original pitch" };
  }

  const { data: inbox } = await supabase
    .from("sender_inboxes")
    .select("id, email, display_name, gmail_refresh_token_encrypted, paused, sends_today, daily_cap")
    .eq("id", pitch.sender_inbox_id)
    .maybeSingle<InboxRow>();

  if (!inbox) {
    return { pitch_id: pitch.id, prospect: prospect.company_name, step: nextStep, status: "skipped", reason: "Sender inbox not found" };
  }
  if (inbox.paused) {
    return { pitch_id: pitch.id, prospect: prospect.company_name, step: nextStep, status: "skipped", reason: "Sender inbox is paused" };
  }
  if (!inbox.gmail_refresh_token_encrypted) {
    return { pitch_id: pitch.id, prospect: prospect.company_name, step: nextStep, status: "skipped", reason: "Inbox not connected to Gmail" };
  }
  if (inbox.sends_today >= inbox.daily_cap) {
    return { pitch_id: pitch.id, prospect: prospect.company_name, step: nextStep, status: "skipped", reason: `Daily cap reached (${inbox.sends_today}/${inbox.daily_cap})` };
  }

  // ── 6. Get access token ───────────────────────────────────────────────────
  const tokenResult = await getAccessToken(inbox.gmail_refresh_token_encrypted);
  if (!tokenResult.ok) {
    return { pitch_id: pitch.id, prospect: prospect.company_name, step: nextStep, status: "skipped", reason: `Token refresh failed: ${tokenResult.error}` };
  }

  // ── 7. Build template ─────────────────────────────────────────────────────
  const ctx: FollowupContext = {
    prospectName: prospect.company_name,
    contactName: contactFirstName,
    originalSubject: pitch.subject,
    painSummary,
    hunterValue,
    market: resolveMarket(prospect.market),
  };

  const template = nextStep === 2 ? buildFollowup1(ctx) : buildFollowup2(ctx);

  // ── 8. Send via Gmail in original thread ─────────────────────────────────
  const sendResult = await sendGmailMessage({
    accessToken: tokenResult.accessToken,
    fromEmail: inbox.email,
    fromName: inbox.display_name,
    to: contactEmail,
    subject: template.subject,
    body: template.body,
    threadId: pitch.gmail_thread_id ?? undefined,
    originalMessageId: pitch.gmail_message_id ?? undefined,
  });

  if (!sendResult.ok) {
    return { pitch_id: pitch.id, prospect: prospect.company_name, step: nextStep, status: "skipped", reason: `Gmail send failed: ${sendResult.error}` };
  }

  const now = new Date().toISOString();

  // ── 9. Insert new pitch row for this follow-up step ───────────────────────
  // sequence_step, next_followup_at, sequence_paused_at are new columns not
  // yet reflected in generated types — cast to any for the insert.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: newPitch } = await (supabase as any)
    .from("pitches")
    .insert({
      tenant_id: pitch.tenant_id,
      prospect_id: pitch.prospect_id,
      contact_id: pitch.contact_id,
      sender_inbox_id: pitch.sender_inbox_id,
      case_study_id: pitch.case_study_id,
      service_id: pitch.service_id,
      pain_id: pitch.pain_id,
      subject: template.subject,
      body_original: template.body,
      body_sent: template.body,
      status: "sent",
      sent_at: now,
      parent_pitch_id: pitch.id,
      follow_up_step: nextStep - 1, // DB uses 0-based: 1 = fu1, 2 = fu2
      sequence_step: nextStep,
      gmail_thread_id: pitch.gmail_thread_id,
      gmail_message_id: sendResult.gmailMessageId,
    })
    .select("id")
    .maybeSingle() as { data: { id: string } | null };

  // ── 10. Update original pitch's next_followup_at ──────────────────────────
  // next_followup_at and sequence_step are new columns not yet in generated
  // types — cast to any for the update.
  if (nextStep === 3) {
    // Final follow-up sent — no more follow-ups
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from("pitches")
      .update({ next_followup_at: null })
      .eq("id", pitch.id);
  } else {
    // Step 2 sent — schedule final follow-up in 5 days
    const nextFollowupAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from("pitches")
      .update({ next_followup_at: nextFollowupAt, sequence_step: nextStep })
      .eq("id", pitch.id);
  }

  // ── 11. Increment inbox sends_today ──────────────────────────────────────
  await supabase
    .from("sender_inboxes")
    .update({ sends_today: inbox.sends_today + 1 })
    .eq("id", inbox.id);

  // ── 12. Audit log ─────────────────────────────────────────────────────────
  await supabase.from("audit_log").insert({
    tenant_id: pitch.tenant_id,
    actor_id: null,            // cron — no human actor
    action: "pitch.sent",     // reuse existing action code
    entity_type: "pitch",
    entity_id: newPitch?.id ?? pitch.id,
    metadata: {
      follow_up_step: nextStep,
      parent_pitch_id: pitch.id,
      inbox_id: inbox.id,
      inbox_email: inbox.email,
      to_email: contactEmail,
      gmail_message_id: sendResult.gmailMessageId,
      gmail_thread_id: pitch.gmail_thread_id,
    },
  });

  return { pitch_id: pitch.id, prospect: prospect.company_name, step: nextStep, status: "sent" };
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const supabase = createServiceRoleClient();

  // ── Find all pitches due for a follow-up ───────────────────────────────────
  // Conditions:
  //   - status = 'sent'
  //   - next_followup_at <= now
  //   - sequence_step < 3  (i.e. we haven't sent the final follow-up yet)
  //   - sequence_paused_at IS NULL
  const now = new Date().toISOString();

  // sequence_step, next_followup_at, sequence_paused_at are new columns not yet
  // in generated types — cast to any for this query.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: duePitches, error: queryError } = await (supabase as any)
    .from("pitches")
    .select(
      "id, tenant_id, prospect_id, contact_id, sender_inbox_id, subject, " +
      "gmail_thread_id, gmail_message_id, sequence_step, " +
      "case_study_id, service_id, pain_id",
    )
    .eq("status", "sent")
    .lte("next_followup_at", now)
    .lt("sequence_step", 3)
    .is("sequence_paused_at", null)
    .not("next_followup_at", "is", null) as {
    data: DuePitchRow[] | null;
    error: { message: string } | null;
  };

  if (queryError) {
    console.error("[follow-up/cron] Query failed:", queryError.message);
    return NextResponse.json(
      { error: "DB query failed", details: queryError.message },
      { status: 500 },
    );
  }

  const pitches = duePitches ?? [];
  console.log(`[follow-up/cron] ${pitches.length} pitches due for follow-up`);

  const results: FollowupResult[] = [];

  for (const pitch of pitches) {
    try {
      const result = await processFollowup(pitch);
      results.push(result);
    } catch (err) {
      console.error(`[follow-up/cron] Error processing pitch ${pitch.id}:`, err);
      results.push({
        pitch_id: pitch.id,
        prospect: "unknown",
        step: pitch.sequence_step + 1,
        status: "skipped",
        reason: `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  return NextResponse.json({
    ok: true,
    duration_ms: Date.now() - startTime,
    total: pitches.length,
    sent,
    skipped,
    results,
  });
}
