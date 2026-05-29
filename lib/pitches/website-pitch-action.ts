"use server";

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
 */

import Anthropic from "@anthropic-ai/sdk";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { claudeIsAvailable, ANTHROPIC_HAIKU_MODEL, computeCostUsd } from "@/lib/anthropic/client";

// ── Types ─────────────────────────────────────────────────────────────────────

export type WebsitePitchResult =
  | { ok: true; pitch_id: string; method: "claude" | "template"; cost_usd: number }
  | { ok: false; error: string };

// ── Entry point ───────────────────────────────────────────────────────────────

export async function generateWebsitePitch(
  prospectId: string,
): Promise<WebsitePitchResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot generate pitches." };

  const supabase = await createClient();

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
      client_name: string;
      industry: string | null;
      hero_metric_en: string | null;
      hero_metric_es: string | null;
    };
    const { data: cases } = await supabase
      .from("case_studies")
      .select("id, client_name, industry, hero_metric_en, hero_metric_es")
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
      const metric =
        (prospect.language === "es" ? match.hero_metric_es : match.hero_metric_en) ??
        match.hero_metric_en;
      caseStudyLine = metric
        ? `We recently helped ${match.client_name} (${match.industry}) — ${metric}.`
        : `We recently helped ${match.client_name} (${match.industry}) get online and start winning customers.`;
      caseStudyId = match.id;
    }
  }

  // ── Load top contact for greeting ─────────────────────────────────────────
  type ContactRow = { full_name: string | null };
  const { data: contactRows } = await supabase
    .from("prospect_contacts")
    .select("full_name")
    .eq("tenant_id", user.tenantId)
    .eq("prospect_id", prospectId)
    .order("priority_rank", { ascending: true })
    .limit(1)
    .returns<ContactRow[]>();

  const firstName =
    contactRows?.[0]?.full_name?.split(" ")[0] ?? null;

  // ── Load top contact id for pitch FK ──────────────────────────────────────
  type ContactIdRow = { id: string };
  const { data: contactIdRow } = await supabase
    .from("prospect_contacts")
    .select("id")
    .eq("tenant_id", user.tenantId)
    .eq("prospect_id", prospectId)
    .order("priority_rank", { ascending: true })
    .limit(1)
    .maybeSingle<ContactIdRow>();

  // ── Generate pitch ────────────────────────────────────────────────────────
  let subject: string;
  let body: string;
  let method: "claude" | "template" = "template";
  let costUsd = 0;

  if (claudeIsAvailable()) {
    const result = await callClaudeForWebsitePitch({
      companyName: prospect.company_name,
      industry: industryLabel,
      market: prospect.market,
      language: prospect.language,
      firstName,
      caseStudyLine,
      senderName: user.fullName ?? "Rünna Team",
    });
    if (result.ok) {
      subject = result.subject;
      body = result.body;
      method = "claude";
      costUsd = result.cost_usd;
    } else {
      // Fall back to deterministic template
      const fallback = buildFallbackPitch({
        companyName: prospect.company_name,
        industry: industryLabel,
        language: prospect.language,
        firstName,
        caseStudyLine,
        senderName: user.fullName ?? "Rünna Team",
      });
      subject = fallback.subject;
      body = fallback.body;
    }
  } else {
    const fallback = buildFallbackPitch({
      companyName: prospect.company_name,
      industry: industryLabel,
      language: prospect.language,
      firstName,
      caseStudyLine,
      senderName: user.fullName ?? "Rünna Team",
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
      contact_id: contactIdRow?.id ?? null,
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
  senderName: string;
}): Promise<{ ok: true; subject: string; body: string; cost_usd: number } | { ok: false }> {
  const greeting = opts.firstName ? `Hi ${opts.firstName},` : "Hi there,";
  const marketLabel =
    opts.market === "MX" ? "Mexico" : opts.market === "US" ? "the US" : "Canada";
  const caseStudyBlock = opts.caseStudyLine
    ? `\n\nReal example: ${opts.caseStudyLine}`
    : "";

  const prompt = `You are a sales email writer for Rünna Advertising, a digital marketing and web design agency.

Write a cold email to ${opts.companyName}, a ${opts.industry} business in ${marketLabel} that has NO website.
The goal is to sell them on getting a professional website built by Rünna.

${opts.language === "es" ? "Write the email in Spanish." : "Write the email in English."}

Use this EXACT structure — replace [INDUSTRY] with specific ${opts.industry}-appropriate language:

Subject: Quick question about ${opts.companyName}

${greeting}

I work with ${opts.industry} businesses across ${marketLabel} helping them show up online and win more customers — and I came across your business recently.

I wanted to ask: is not having a website a deliberate choice, or just something that hasn't happened yet?

I ask because most of the business owners I talk to in [${opts.industry} industry] tell me the same thing — they know they need one, but it always feels expensive, slow, or complicated. So it keeps getting pushed back.

We built Rünna specifically to solve that. We get [${opts.industry}] businesses online in 2–3 weeks, at a cost that makes sense for a growing business, and built to bring in real customers — not just look pretty.

What a good website does for a [${opts.industry}] business:
✓ Shows up when locals search for what you offer
✓ Builds instant credibility (customers Google you before they call)
✓ Works as your 24/7 salesperson — capturing leads while you sleep
✓ Gives you something real to point to on social media
✓ Makes you look like the obvious, professional choice vs. competitors${caseStudyBlock}

If you've been meaning to get this done, I'd love to make it easy. Happy to show you an example or two from [${opts.industry}] businesses we've built for.

Worth a quick chat?

${opts.senderName}
Rünna Advertising
runna.agency

Rules:
- Replace every [${opts.industry}] placeholder with industry-specific, natural-sounding language
- Keep tone warm and conversational — not salesy or pushy
- Subject line must feel like a genuine question, not a sales pitch
- 250–350 words max in the body
- Return ONLY the email. First line: "Subject: ..." then blank line then body. Nothing else.`;

  try {
    const client = new Anthropic();
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
      : `Quick question about ${opts.companyName}`;

    // Body starts after the subject line + blank line
    const subjectIdx = lines.findIndex((l) => l.toLowerCase().startsWith("subject:"));
    const bodyLines = subjectIdx >= 0 ? lines.slice(subjectIdx + 1) : lines;
    const bodyParsed = bodyLines
      .join("\n")
      .replace(/^\n+/, "")
      .trim();

    const cost_usd = computeCostUsd(
      ANTHROPIC_HAIKU_MODEL,
      msg.usage.input_tokens,
      msg.usage.output_tokens,
    );

    return { ok: true, subject: subjectParsed, body: bodyParsed, cost_usd };
  } catch {
    return { ok: false };
  }
}

// ── Deterministic fallback template ──────────────────────────────────────────

function buildFallbackPitch(opts: {
  companyName: string;
  industry: string;
  language: "en" | "es";
  firstName: string | null;
  caseStudyLine: string | null;
  senderName: string;
}): { subject: string; body: string } {
  const greeting = opts.firstName ? `Hi ${opts.firstName},` : "Hi there,";
  const caseStudyBlock = opts.caseStudyLine
    ? `\n\n${opts.caseStudyLine}\n`
    : "";

  const subject = `Quick question about ${opts.companyName}`;
  const body = `${greeting}

I work with ${opts.industry} businesses helping them show up online and win more customers — and I came across your business recently.

I wanted to ask: is not having a website a deliberate choice, or just something that hasn't happened yet?

I ask because most of the business owners I talk to in ${opts.industry} tell me the same thing — they know they need one, but it always feels expensive, slow, or complicated. So it keeps getting pushed back.

We built Rünna specifically to solve that. We get ${opts.industry} businesses online in 2–3 weeks, at a cost that makes sense for a growing business, and built to bring in real customers — not just look pretty.

What a good website does for a ${opts.industry} business:
✓ Shows up when locals search for what you offer
✓ Builds instant credibility (customers Google you before they call)
✓ Works as your 24/7 salesperson — capturing leads while you sleep
✓ Gives you something real to point to on social media
✓ Makes you look like the obvious, professional choice vs. competitors${caseStudyBlock}

If you've been meaning to get this done, I'd love to make it easy. Happy to show you an example or two from ${opts.industry} businesses we've built for.

Worth a quick chat?

${opts.senderName}
Rünna Advertising
runna.agency`;

  return { subject, body };
}
