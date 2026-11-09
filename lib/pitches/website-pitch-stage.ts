/**
 * Website Pitch Generator — for prospects with no website.
 *
 * These prospects can't be scraped or scored normally. Instead of
 * suppressing them, we auto-generate a pitch selling them on the VALUE
 * of getting a website, adapted to their industry + market.
 *
 * Uses Claude-haiku (cheap — mostly template adaptation, not synthesis).
 * Falls back to a deterministic template if Claude is unavailable.
 *
 * Filter applied BEFORE calling this:
 *   - !domain && !website_url  (confirmed no web presence)
 *   - icp_id != null           (must be tied to a specific campaign ICP)
 *
 * This function ALSO re-checks that the prospect has a usable contact email and
 * refuses otherwise — the caller's filter is not trusted, and an unreachable
 * prospect must not cost a Claude call.
 */

import { revalidatePath } from "next/cache";
import type { Actor } from "@/lib/actor";
import {
  claudeIsAvailable,
  getClient,
  ANTHROPIC_HAIKU_MODEL,
  computeCostUsd,
  type ClaudeUsage,
} from "@/lib/anthropic/client";
import { isUnderDailyCap, recordClaudeCall } from "@/lib/anthropic/cost-tracking";
import { fetchTopUsableContact } from "@/lib/pitches/contacts";
import { senderSignature } from "@/lib/pitches/sender-identity";
import { refreshGateAfterChange } from "@/lib/pitches/gate";
import { recordPitchEvent } from "@/lib/pitches/events";
import { DECISION_VERSION, recipientSummary, registerFor, type DecisionRecord } from "@/lib/pitches/decision";
import { isRoleBasedEmail } from "@/lib/research/email-utils";
import { decisionExemplarFields } from "@/lib/pitches/exemplars";
import { WEBSITE_PROMPT_VERSION, websiteCaseStudyLine, websiteFallbackPitch, websitePitchPrompt, websiteSubject } from "@/lib/pitches/website-pitch-copy";

// ── Types ─────────────────────────────────────────────────────────────────────

export type WebsitePitchResult =
  | { ok: true; pitch_id: string; method: "claude" | "template"; cost_usd: number }
  | { ok: false; error: string };

// ── Entry point ───────────────────────────────────────────────────────────────

export async function generateWebsitePitchWith(
  actor: Actor,
  prospectId: string,
): Promise<WebsitePitchResult> {
  const { user } = actor;
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot generate pitches." };

  const { supabase } = actor;

  // ── Load prospect ─────────────────────────────────────────────────────────
  type ProspectRow = {
    id: string;
    company_name: string;
    industry: string | null;
    market: "CA" | "MX" | "US" | "LATAM";
    language: "en" | "es";
    icp_id: string | null;
  };
  const { data: prospect, error: pErr } = await supabase
    .from("prospects")
    .select("id, company_name, industry, market, language, icp_id")
    .eq("id", prospectId)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<ProspectRow>();

  if (pErr || !prospect) return { ok: false, error: pErr?.message ?? "Prospect not found." };

  // ── Derive industry from ICP if prospect.industry is blank ────────────────
  let industry = prospect.industry ?? null;
  if (!industry && prospect.icp_id) {
    type IcpRow = { industry_tags: string[] };
    const { data: icp } = await supabase
      .from("icps")
      .select("industry_tags")
      .eq("id", prospect.icp_id)
      .eq("tenant_id", user.tenantId)
      .maybeSingle<IcpRow>();
    industry = icp?.industry_tags?.[0] ?? null;
  }

  const industryLabel = industry ?? "business";

  // ── Find matching case study by industry (optional enrichment) ────────────
  let caseStudyLine: string | null = null;
  let caseStudyId: string | null = null;
  if (industry) {
    type CaseRow = {
      id: string;
      industry: string | null;
    };
    const { data: cases } = await supabase
      .from("case_studies")
      .select("id, industry")
      .eq("tenant_id", user.tenantId)
      .eq("is_active", true)
      .returns<CaseRow[]>();

    const match = (cases ?? []).find(
      (c) =>
        c.industry &&
        (c.industry.toLowerCase().includes(industry!.toLowerCase()) ||
          industry!.toLowerCase().includes(c.industry.toLowerCase())),
    );
    if (match) {
      // Named clients removed 2026-07-22 (Pedro override): named examples
      // consistently underperform. The case study LINK is kept — case_study_id
      // feeds the learning loop's rejection downranking — but the line now
      // describes the WORK, never who it was for or how often we do it
      // (proven facts, 2026-11-09: "we do this all the time for [industry]
      // like yours" is a track record we can't show).
      // The hero metric goes with the name: a number stripped of its source
      // reads as invented, which is worse than no number at all.
      caseStudyLine = websiteCaseStudyLine(prospect.language);
      caseStudyId = match.id;
    }
  }

  // ── Contact gate — never generate a pitch we can't send ───────────────────
  // Mirrors the guard in generatePitch. Without it this lane happily produced
  // drafts with contact_id=null, which the send queue then silently refuses to
  // pick up: 11 of them piled up on /pitches as "Approved" but unsendable.
  // Runs BEFORE the Claude call so an unreachable prospect costs nothing.
  //
  // Note this reads the top USABLE contact, not merely the top-ranked row —
  // a junk address (glued TLD, builder placeholder) is not a way to reach them.
  const topUsable = await fetchTopUsableContact(supabase, user.tenantId, prospectId);
  if (!topUsable) {
    return {
      ok: false,
      error: "No contact email — find or add a contact before generating a pitch.",
    };
  }

  const firstName = topUsable.full_name?.split(" ")[0] ?? null;

  // ── Generate pitch ────────────────────────────────────────────────────────
  let subject: string;
  let body: string;
  let method: "claude" | "template" = "template";
  let costUsd = 0;

  // Daily-cap safety net — over budget, skip Claude and use the deterministic
  // template (same as "Claude unavailable").
  const cap = claudeIsAvailable() ? await isUnderDailyCap(user.tenantId) : null;
  if (claudeIsAvailable() && cap?.under) {
    const result = await callClaudeForWebsitePitch({
      companyName: prospect.company_name,
      industry: industryLabel,
      market: prospect.market,
      language: prospect.language,
      firstName,
      caseStudyLine,
      signature: senderSignature(prospect.language),
    });
    if (result.ok) {
      subject = result.subject;
      body = result.body;
      method = "claude";
      costUsd = result.cost_usd;
      // Record spend so the cap accounts for it (was previously uncapped).
      await recordClaudeCall({
        tenantId: user.tenantId,
        model: ANTHROPIC_HAIKU_MODEL,
        entity_type: "pitch",
        entity_id: prospectId,
        usage: result.usage,
      });
    } else {
      // Fall back to the deterministic template, in the prospect's own language
      // (a Mexican owner must never get the English one because Claude was down).
      const fallback = websiteFallbackPitch({
        companyName: prospect.company_name,
        industry: industryLabel,
        language: prospect.language,
        firstName,
        caseStudyLine,
        signature: senderSignature(prospect.language),
      });
      subject = fallback.subject;
      body = fallback.body;
    }
  } else {
    const fallback = websiteFallbackPitch({
      companyName: prospect.company_name,
      industry: industryLabel,
      language: prospect.language,
      firstName,
      caseStudyLine,
      signature: senderSignature(prospect.language),
    });
    subject = fallback.subject;
    body = fallback.body;
  }

  // ── Save pitch ────────────────────────────────────────────────────────────
  const { data: created, error: insertErr } = await supabase
    .from("pitches")
    .insert({
      tenant_id: user.tenantId,
      prospect_id: prospectId,
      contact_id: topUsable.id,
      case_study_id: caseStudyId,
      pain_id: null, // website pitch has no pain taxonomy entry
      subject,
      body_original: body,
      measurable_result_included: caseStudyLine !== null,
      quality_self_score: 0.6, // reasonable default for templated pitch
      status: "draft",
      cost_usd: costUsd,
      variant_index: 1,
    })
    .select("id")
    .single<{ id: string }>();

  if (insertErr) return { ok: false, error: `Could not save pitch: ${insertErr.message}` };
  if (!created) return { ok: false, error: "Insert returned no row." };

  // Send gate v2 verdict, shown on /pitches; approve and send re-check.
  const gateAtGeneration = await refreshGateAfterChange(supabase, user.tenantId, created.id);

  // Decision record (write-once), same shape as first-touch pitches.
  const decision: DecisionRecord = {
    v: DECISION_VERSION,
    created_at: new Date().toISOString(),
    path: method === "claude" ? "website_claude" : "website_template",
    prompt_version: WEBSITE_PROMPT_VERSION,
    model: method === "claude" ? ANTHROPIC_HAIKU_MODEL : null,
    fallback_reason: null,
    lang: prospect.language,
    // No size estimate on this path; the copy uses the tú/plural register.
    register: registerFor(prospect.language, "smb"),
    segment: { industry: prospect.industry, market: prospect.market, size_band: "unknown" },
    pain: { id: null, label: "no website" },
    benchmarks_offered: [],
    benchmark_cited: null,
    attribution_code: null,
    recipient: recipientSummary({ ...topUsable, email_is_role_based: isRoleBasedEmail(topUsable.email) }),
    critic: null,
    // This writer has its own prompt (the value of a website) and takes no
    // exemplars; recorded so every decision record has the field.
    ...decisionExemplarFields(method === "claude" ? "website_claude" : "website_template", []),
    gate: gateAtGeneration
      ? { version: gateAtGeneration.version, pass: gateAtGeneration.pass, codes: gateAtGeneration.failures.map((f) => f.code) }
      : null,
  };
  await supabase.from("pitches").update({ decision } as never).eq("id", created.id).eq("tenant_id", user.tenantId);
  await recordPitchEvent(supabase, {
    tenantId: user.tenantId,
    pitchId: created.id,
    type: "generated",
    payload: { path: decision.path, prompt_version: decision.prompt_version, gate_pass: decision.gate?.pass ?? null },
  });

  revalidatePath("/pitches");
  revalidatePath(`/companies/${prospectId}`);

  return { ok: true, pitch_id: created.id, method, cost_usd: costUsd };
}

// ── Claude call ───────────────────────────────────────────────────────────────

async function callClaudeForWebsitePitch(opts: {
  companyName: string;
  industry: string;
  market: "CA" | "MX" | "US" | "LATAM";
  language: "en" | "es";
  firstName: string | null;
  caseStudyLine: string | null;
  /** Two-line sign-off, e.g. "Nils\nRunna Advertising" (lib/pitches/sender-identity). */
  signature: string;
}): Promise<{ ok: true; subject: string; body: string; cost_usd: number; usage: ClaudeUsage } | { ok: false }> {
  // The words live in lib/pitches/website-pitch-copy.ts (pure, tested): our
  // offer, and about them only their name and industry.
  const prompt = websitePitchPrompt(opts);

  try {
    const client = getClient();
    const msg = await client.messages.create({
      model: ANTHROPIC_HAIKU_MODEL,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
      .trim();

    // Parse "Subject: ..." from first line, rest is body
    const lines = raw.split("\n");
    const subjectLine = lines.find((l) => l.toLowerCase().startsWith("subject:"));
    const subjectParsed = subjectLine
      ? subjectLine.replace(/^subject:\s*/i, "").trim()
      : websiteSubject(opts);

    // Body starts after the subject line + blank line
    const subjectIdx = lines.findIndex((l) => l.toLowerCase().startsWith("subject:"));
    const bodyLines = subjectIdx >= 0 ? lines.slice(subjectIdx + 1) : lines;
    const bodyParsed = bodyLines
      .join("\n")
      .replace(/^\n+/, "")
      // Em dashes are banned (and gated); Haiku still slips them in.
      .replace(/\s*—\s*/g, ", ")
      .trim();

    const cost_usd = computeCostUsd(
      ANTHROPIC_HAIKU_MODEL,
      msg.usage.input_tokens,
      msg.usage.output_tokens,
    );

    const usage: ClaudeUsage = {
      input_tokens: msg.usage.input_tokens,
      output_tokens: msg.usage.output_tokens,
      cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
      cost_usd,
    };

    return { ok: true, subject: subjectParsed, body: bodyParsed, cost_usd, usage };
  } catch {
    return { ok: false };
  }
}
