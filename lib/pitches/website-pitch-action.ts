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
 *
 * This function ALSO re-checks that the prospect has a usable contact email and
 * refuses otherwise — the caller's filter is not trusted, and an unreachable
 * prospect must not cost a Claude call.
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  claudeIsAvailable,
  getClient,
  ANTHROPIC_HAIKU_MODEL,
  computeCostUsd,
  type ClaudeUsage,
} from "@/lib/anthropic/client";
import { isUnderDailyCap, recordClaudeCall } from "@/lib/anthropic/cost-tracking";
import { fetchTopUsableContact } from "@/lib/pitches/contacts";

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
      // describes the WORK at industry level instead of naming who it was for.
      // The hero metric goes with the name: a number stripped of its source
      // reads as invented, which is worse than no number at all.
      caseStudyLine =
        prospect.language === "es"
          ? `Esto lo hacemos seguido para negocios de ${match.industry ?? "este giro"}, el trabajo está en que los encuentre la gente que ya anda buscando lo que ustedes hacen.`
          : `We do this all the time for ${match.industry ?? "businesses"} like yours, the work is getting you found by the people already looking for what you do.`;
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
      senderName: user.fullName ?? "Rünna Team",
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
}): Promise<{ ok: true; subject: string; body: string; cost_usd: number; usage: ClaudeUsage } | { ok: false }> {
  // Localized greeting. "Hi there," is banned project-wide (reads as a mail
  // merge); fall back to the team form, in the prospect's own language.
  const greeting =
    opts.language === "es"
      ? opts.firstName
        ? `Hola ${opts.firstName},`
        : `Hola equipo de ${opts.companyName},`
      : opts.firstName
        ? `Hi ${opts.firstName},`
        : `Hi ${opts.companyName} team,`;
  const marketLabel =
    opts.market === "MX" ? "Mexico" : opts.market === "US" ? "the US" : "Canada";
  const caseStudyBlock = opts.caseStudyLine
    ? `\n\n${opts.caseStudyLine}`
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

// ── Deterministic fallback template ──────────────────────────────────────────

function buildFallbackPitch(opts: {
  companyName: string;
  industry: string;
  language: "en" | "es";
  firstName: string | null;
  caseStudyLine: string | null;
  senderName: string;
}): { subject: string; body: string } {
  // Spanish prospects must never receive the English template just because
  // Claude was unavailable (API error or daily cap) — the fallback is exactly
  // when a Mexican owner would get an out-of-language cold email.
  if (opts.language === "es") return buildFallbackPitchEs(opts);

  const greeting = opts.firstName
    ? `Hi ${opts.firstName},`
    : `Hi ${opts.companyName} team,`;
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

/** Spanish twin of buildFallbackPitch — MX/LATAM prospects, natural business register. */
function buildFallbackPitchEs(opts: {
  companyName: string;
  industry: string;
  firstName: string | null;
  caseStudyLine: string | null;
  senderName: string;
}): { subject: string; body: string } {
  const greeting = opts.firstName
    ? `Hola ${opts.firstName},`
    : `Hola equipo de ${opts.companyName},`;
  const caseStudyBlock = opts.caseStudyLine ? `\n\n${opts.caseStudyLine}\n` : "";

  const subject = `Una pregunta sobre ${opts.companyName}`;
  const body = `${greeting}

Trabajo con negocios de ${opts.industry} ayudándoles a tener presencia en internet y atraer más clientes, y hace poco me encontré con su negocio.

Quería preguntarles: ¿no tener sitio web es una decisión deliberada, o simplemente algo que no ha pasado todavía?

Lo pregunto porque la mayoría de los dueños con los que hablo en ${opts.industry} me dicen lo mismo: saben que lo necesitan, pero siempre se siente caro, lento o complicado. Y así se va posponiendo.

En Rünna construimos justo para resolver eso. Ponemos en línea a negocios de ${opts.industry} en 2 o 3 semanas, a un costo que tiene sentido para un negocio en crecimiento, y hecho para traer clientes reales, no solo para verse bonito.

Lo que un buen sitio web hace por un negocio de ${opts.industry}:
✓ Aparecen cuando alguien cerca busca lo que ustedes ofrecen
✓ Genera confianza inmediata (la gente los busca en Google antes de llamar)
✓ Trabaja como su vendedor 24/7, capturando clientes mientras duermen
✓ Les da algo real a dónde dirigir a sus seguidores en redes
✓ Los posiciona como la opción profesional y obvia frente a la competencia${caseStudyBlock}

Si han tenido esto pendiente, con gusto se los hago fácil. Puedo mostrarles un par de ejemplos de negocios de ${opts.industry} que hemos construido.

¿Vale la pena una llamada corta?

${opts.senderName}
Rünna Advertising
runna.agency`;

  return { subject, body };
}
