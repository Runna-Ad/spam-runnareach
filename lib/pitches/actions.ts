"use server";

import { revalidatePath } from "next/cache";
import { recordGateDryRun } from "@/lib/pitches/gate-dryrun";
import { z } from "zod";
import { claudeIsAvailable } from "@/lib/anthropic/client";
import { isUnderDailyCap, recordClaudeCall } from "@/lib/anthropic/cost-tracking";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import type { CurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";
import { composePitchWithClaude } from "./claude-composer";
import { renderIndustryTemplate } from "./industry-templates";
import { buildHunterUrlForPitch } from "./hunter-mapping";
import { hasUsableEmail, isRoleBasedEmail } from "@/lib/research/email-utils";
import { fetchTopUsableContact } from "@/lib/pitches/contacts";
import {
  type ComposedPitch,
  type GeneratorInputContact,
  type GeneratorInputCaseStudy,
  type GeneratorInputNotableClient,
  type GeneratorInputResearchPain,
  type GeneratorInputs,
} from "./generator";
import { listNotableClients } from "@/lib/notable-clients/queries";

const generateSchema = z.object({
  prospect_id: z.string().uuid(),
});
const editSchema = z.object({
  pitch_id: z.string().uuid(),
  subject: z.string().trim().min(1).max(300),
  body_edited: z.string().trim().min(1).max(20_000),
});
// Reason "kinds" for rejecting a pitch. These feed back into the
// generator: counts per (case_study_id, pain_id) downrank that pair so
// the next pitch picks differently.
const REJECTION_REASON_KINDS = [
  "wrong_case",     // case study doesn't address this pain (Pet's Club for checkout = wrong_case)
  "wrong_pain",     // we picked the wrong pain to focus on
  "tone_off",       // copy doesn't match brand voice / too salesy / too cold
  "wrong_contact",  // wrong person / role / department
  "other",
] as const;

const transitionSchema = z.object({
  pitch_id: z.string().uuid(),
  next_status: z.enum([
    "draft",
    "queued_for_approval",
    "approved",
    "reviewer_rejected",
  ]),
  rejection_reason: z.string().trim().max(500).nullable().optional(),
  rejection_reason_kind: z.enum(REJECTION_REASON_KINDS).optional(),
});

export type GeneratePitchResult =
  | {
      ok: true;
      pitch_id: string;
      method: "heuristic" | "claude";
      quality_self_score: number;
      reasoning: string;
    }
  | { ok: false; error: string };

export type PitchActionResult = { ok: true } | { ok: false; error: string };

/**
 * Generate a draft pitch for a prospect. Reads research + contacts +
 * case_studies, runs the heuristic composer, persists to pitches.
 *
 * Can be called with pre-authenticated user + supabase (from pipeline)
 * to avoid a second requireUser() call deep in a server action chain,
 * which can fail when cookies() is restricted in nested contexts.
 */
export async function generatePitch(
  prospectId: string,
  injected?: {
    user: CurrentUser;
    supabase: Awaited<ReturnType<typeof createClient>>;
  },
): Promise<GeneratePitchResult> {
  const user = injected?.user ?? await requireUser();
  const supabase = injected?.supabase ?? await (await import("@/lib/supabase/server")).createClient();

  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot generate pitches." };
  }

  const parsed = generateSchema.safeParse({ prospect_id: prospectId });
  if (!parsed.success) return { ok: false, error: "Invalid prospect id." };

  // Load prospect + research in parallel — research fields feed directly into pitch quality.
  type ProspectRow = {
    id: string;
    company_name: string;
    industry: string | null;
    language: "en" | "es";
    employee_size_estimate: number | null;
    city: string | null;
    market: string | null;
    domain: string | null;
    website_url: string | null;
  };
  type ResearchRow = {
    pain_points: unknown;
    what_they_do: string | null;
    tech_stack: string[];
  };

  const [{ data: prospect, error: prospectErr }, { data: research }] = await Promise.all([
    supabase
      .from("prospects")
      .select("id, company_name, industry, language, employee_size_estimate, city, market, domain, website_url")
      .eq("id", parsed.data.prospect_id)
      .eq("tenant_id", user.tenantId)
      .maybeSingle<ProspectRow>(),
    supabase
      .from("prospect_research")
      .select("pain_points, what_they_do, tech_stack")
      .eq("tenant_id", user.tenantId)
      .eq("prospect_id", parsed.data.prospect_id)
      .maybeSingle<ResearchRow>(),
  ]);

  if (prospectErr) return { ok: false, error: `Lookup failed: ${prospectErr.message}` };
  if (!prospect) return { ok: false, error: "Prospect not found." };

  const pains: GeneratorInputResearchPain[] = normalizePains(research?.pain_points ?? null);

  // Load contacts — include role_title so Claude can address "as founder/GM of..."
  type ContactRow = {
    full_name: string | null;
    email: string | null;
    email_is_role_based: boolean;
    role_title: string | null;
    priority_rank: number;
  };
  const { data: contactRows } = await supabase
    .from("prospect_contacts")
    .select("full_name, email, email_is_role_based, role_title, priority_rank")
    .eq("tenant_id", user.tenantId)
    .eq("prospect_id", parsed.data.prospect_id)
    .order("priority_rank", { ascending: true })
    .limit(5)
    .returns<ContactRow[]>();
  const contacts: GeneratorInputContact[] = (contactRows ?? []).map((c) => ({
    full_name: c.full_name,
    email: c.email,
    // Re-derive at pitch time as a safety net: legacy/enriched contacts may have
    // a stale email_is_role_based=false (e.g. info@ from Hunter), and the composer
    // uses this to add the "if you're not the right person, please forward" line.
    email_is_role_based: c.email_is_role_based || (c.email ? isRoleBasedEmail(c.email) : false),
    role_title: c.role_title ?? null,
  }));

  // ── Contact gate ──────────────────────────────────────────────────────────
  // Never generate a pitch we can't send. A prospect with no usable contact
  // email (none found, or only placeholder/empty rows) is skipped here so the
  // single "Generate pitch" button, bulk generation, and the pipeline all refuse
  // consistently instead of producing an unsendable draft. (tasks/lessons.md:
  // "Never auto-generate a pitch you can't send".)
  if (!contacts.some((c) => hasUsableEmail(c.email))) {
    return {
      ok: false,
      error: "No contact email — find or add a contact before generating a pitch.",
    };
  }

  // Load case studies + their pain_tags. We pull all active case studies
  // and their tags, then attach the strength for the pain we'll choose.
  // Pull rich context (result paragraph + testimonial + measurable_results)
  // so Claude can reason about semantic fit, not just client_name.
  type CaseRow = {
    id: string;
    client_name: string;
    industry: string | null;
    hero_metric_en: string | null;
    hero_metric_es: string | null;
    result_description_en: string | null;
    result_description_es: string | null;
    testimonial_quote_en: string | null;
    testimonial_quote_es: string | null;
    measurable_results: unknown;
    tier: "smb" | "mid_market" | "enterprise";
    case_study_pain_tags: { pain_id: string; strength: number }[];
  };
  const { data: caseRows, error: caseErr } = await supabase
    .from("case_studies")
    .select(
      `
      id, client_name, industry, hero_metric_en, hero_metric_es,
      result_description_en, result_description_es,
      testimonial_quote_en, testimonial_quote_es,
      measurable_results, tier,
      case_study_pain_tags(pain_id, strength)
    `,
    )
    .eq("tenant_id", user.tenantId)
    .eq("is_active", true)
    .returns<CaseRow[]>();
  if (caseErr) return { ok: false, error: `Lookup failed: ${caseErr.message}` };
  // Case studies are no longer a hard requirement — the 3-tier fallback
  // can produce a credible pitch using notable clients when there are no
  // matched case studies.

  // Load notable clients for Tier 2 / Tier 3 fallback.
  // Filter by prospect market if available (prefer market-relevant clients).
  let notableClientRows: GeneratorInputNotableClient[] = [];
  try {
    const allClients = await listNotableClients(user.tenantId);

    // Filter notable clients by prospect size — prevents enterprise name-drops
    // (Ford, La Comer, DiDi) appearing in pitches to SMB boutique prospects.
    const prospectSize =
      (prospect.employee_size_estimate ?? 0) >= 500 ? "enterprise" :
      (prospect.employee_size_estimate ?? 0) >= 50  ? "mid_market" : "smb";
    const sizeClients = allClients.filter((nc) =>
      prospectSize === "enterprise" ? true :
      prospectSize === "mid_market" ? nc.tier !== "enterprise" :
      nc.tier === "smb"
    );

    notableClientRows = sizeClients.map((nc) => ({
      id: nc.id,
      name: nc.name,
      industry_tags: nc.industry_tags,
      markets: nc.markets,
      relationship_description: nc.relationship_description,
      key_result: nc.key_result,
      description_en: nc.description_en,
      description_es: nc.description_es,
    }));
  } catch {
    // Non-fatal — pitch still works without notable clients
  }

  // Determine the chosen pain for case-study scoring (must mirror the
  // generator's pick: first evidenced pain, fallback to first labeled).
  const evidencedPain = pains.find((p) => p.pain_id && p.evidence_quote) ?? null;
  const labelOnlyPain =
    !evidencedPain ? pains.find((p) => p.pain_label && p.pain_id) ?? null : null;
  const chosenPainId = (evidencedPain ?? labelOnlyPain)?.pain_id ?? null;
  // Same chosen pain drives the Hunter handoff (timesink + pinned hero finding).
  const chosenPainLabel = (evidencedPain ?? labelOnlyPain)?.pain_label ?? null;

  // Layer 4: read recent rejection counts per (case_study_id, pain_id) so
  // we can downrank case studies that the team already rejected for this
  // pain. Penalty: -0.1 per rejection in the last 30 days, applied to
  // pain_strength. Capped so a 5-rejection case still has 0 strength
  // (won't be picked over an untagged one), but a 1-rejection case at
  // strength 0.8 stays usable at 0.7.
  const rejectionCounts = await loadRejectionCountsByCasePain(
    supabase,
    user.tenantId,
    chosenPainId,
  );

  const allCases: GeneratorInputCaseStudy[] = caseRows.map((cs) => ({
    id: cs.id,
    client_name: cs.client_name,
    industry: cs.industry,
    hero_metric_en: cs.hero_metric_en,
    hero_metric_es: cs.hero_metric_es,
    result_description_en: cs.result_description_en,
    result_description_es: cs.result_description_es,
    testimonial_quote_en: cs.testimonial_quote_en,
    testimonial_quote_es: cs.testimonial_quote_es,
    measurable_results: normalizeMeasurableResults(cs.measurable_results),
    pain_strength: applyRejectionDownrank(
      chosenPainId
        ? cs.case_study_pain_tags.find((t) => t.pain_id === chosenPainId)?.strength ?? null
        : null,
      rejectionCounts.get(`${cs.id}:${chosenPainId ?? ""}`) ?? 0,
    ),
    tier: cs.tier,
  }));

  // HARD FILTER: only pass case studies that are tagged for the chosen
  // pain at strength ≥ 0.4. This prevents Claude from picking a same-
  // industry but wrong-problem case (e.g. Pet's Club packaging case for
  // a Pet Food prospect with a checkout-flow pain). If chosenPainId is
  // null (no pain identified) we keep all cases — Claude can pick on
  // industry alone since there's no pain signal to violate.
  const case_studies: GeneratorInputCaseStudy[] = chosenPainId
    ? allCases.filter((cs) => (cs.pain_strength ?? 0) >= 0.4)
    : allCases;

  const generatorInputs: GeneratorInputs = {
    prospect: {
      ...prospect,
      what_they_do: research?.what_they_do ?? null,
      tech_stack: research?.tech_stack ?? [],
    },
    pains,
    contacts,
    case_studies,
    notable_clients: notableClientRows,
    sender: {
      full_name: user.fullName,
      tenant_display_name: user.tenantDisplayName,
    },
    // Inefficiency Hunter CTA — pre-fills the audit + pins the email's hero play.
    // Derived from the prospect + chosen pain; degrades gracefully on the Hunter
    // side if any param is missing/unknown.
    deep_pitch_url: buildHunterUrlForPitch({
      language: prospect.language,
      market: prospect.market,
      industry: prospect.industry,
      employeeEstimate: prospect.employee_size_estimate,
      painLabel: chosenPainLabel,
      techStack: research?.tech_stack ?? [],
      domain: prospect.domain,
      websiteUrl: prospect.website_url,
    }),
  };

  // ── PHASE 2: try Claude first, fall back to heuristic ─────────────────
  // Claude path requires both an API key AND headroom under the daily
  // spend cap. Any failure (network, parse, schema, cap) drops through
  // to the deterministic heuristic so the user still gets a draft.
  let composed: ComposedPitch | null = null;
  let method: "heuristic" | "claude" = "heuristic";
  let claudeUsage: { input_tokens: number; output_tokens: number; cost_usd: number } | null = null;
  let claudeModel: string | null = null;
  let claudeFallbackReason: string | null = null;

  if (claudeIsAvailable()) {
    const cap = await isUnderDailyCap(user.tenantId);
    if (!cap.under) {
      claudeFallbackReason = `daily cap hit (spent $${cap.spent_today_usd.toFixed(2)} of $${cap.cap_usd.toFixed(2)})`;
    } else {
      const claudeResult = await composePitchWithClaude(generatorInputs);
      if (claudeResult.ok) {
        composed = claudeResult.result.composed;
        method = "claude";
        claudeUsage = claudeResult.result.usage;
        claudeModel = claudeResult.result.model;
      } else {
        claudeFallbackReason = `${claudeResult.reason}: ${claudeResult.error.slice(0, 200)}`;
        // We still got a usage object (sometimes parse failures cost
        // tokens) — record it so the daily cap stays honest.
        if (claudeResult.usage) {
          await recordClaudeCall({
            tenantId: user.tenantId,
            model: "claude-sonnet-4-5-20250929",
            entity_type: "pitch",
            entity_id: parsed.data.prospect_id,
            usage: claudeResult.usage,
            metadata: { fallback: true, reason: claudeResult.reason, error: claudeResult.error.slice(0, 500) },
          });
        }
      }
    }
  }

  if (!composed) {
    // Use industry-specific template fallback instead of the old generic heuristic.
    // Templates are Pedro-authored, properly copywritten, and CTA to the Inefficiency Hunter.
    // The old composePitchHeuristic is kept for reference but no longer used in production.
    composed = renderIndustryTemplate(generatorInputs, claudeFallbackReason ?? "Claude unavailable");
    method = "heuristic";
  }

  if (!composed) {
    return {
      ok: false,
      error: "Generator returned no pitch — no pains or contacts to compose from.",
    };
  }

  // Link the FK to the top USABLE contact (not just the top priority row, which
  // could be a name-only/placeholder contact) so the pitch addresses correctly.
  const topUsable = await fetchTopUsableContact(supabase, user.tenantId, parsed.data.prospect_id);

  type PitchInsert = Database["public"]["Tables"]["pitches"]["Insert"];
  const insert: PitchInsert = {
    tenant_id: user.tenantId,
    prospect_id: parsed.data.prospect_id,
    contact_id: topUsable?.id ?? null,
    case_study_id: composed.case_study_id,
    pain_id: composed.pain_id,
    subject: composed.subject,
    body_original: composed.body,
    measurable_result_included: composed.measurable_result_included,
    quality_self_score: composed.quality_self_score,
    status: "draft",
    cost_usd: claudeUsage?.cost_usd ?? 0,
    token_count_in: claudeUsage?.input_tokens ?? null,
    token_count_out: claudeUsage?.output_tokens ?? null,
    variant_index: 1,
  };
  // preview_text added in migration 0014 — spread after typed insert until
  // types are regenerated with `npx supabase gen types typescript`.
  const insertWithPreview = { ...insert, preview_text: composed.preview_text };

  // Delete any existing draft pitches for this prospect so we don't accumulate
  // stale copies. Drafts haven't been approved or sent, so deletion is safe.
  await supabase
    .from("pitches")
    .delete()
    .eq("tenant_id", user.tenantId)
    .eq("prospect_id", parsed.data.prospect_id)
    .eq("status", "draft");

  const { data: created, error: insertErr } = await supabase
    .from("pitches")
    .insert(insertWithPreview)
    .select("id")
    .single<{ id: string }>();

  if (insertErr) return { ok: false, error: `Could not save pitch: ${insertErr.message}` };
  if (!created) return { ok: false, error: "Insert returned no row." };

  // Record successful Claude call cost (failures recorded earlier
  // in the fallback branch).
  if (method === "claude" && claudeUsage && claudeModel) {
    await recordClaudeCall({
      tenantId: user.tenantId,
      model: claudeModel,
      entity_type: "pitch",
      entity_id: created.id,
      usage: { ...claudeUsage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      metadata: { pitch_id: created.id, prospect_id: parsed.data.prospect_id },
    });
  }

  await writeAuditLog({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "prospect.scored", // closest existing canonical; Phase 2 adds pitch.generated
    entityType: "prospect",
    entityId: parsed.data.prospect_id,
    metadata: {
      kind: "pitch.generated",
      pitch_id: created.id,
      method,
      quality_self_score: composed.quality_self_score,
      case_study_id: composed.case_study_id,
      pain_id: composed.pain_id,
      cost_usd: claudeUsage?.cost_usd ?? 0,
      fallback_reason: claudeFallbackReason,
    },
  });

  // Pre-send gate DRY RUN — records what the gate WOULD decide, changes nothing.
  // Collecting this on real pitches is how we earn the right to auto-send:
  // it shows whether the gate agrees with Pedro before it can block anything.
  await recordGateDryRun(supabase, user.tenantId, user.id, created.id);

  // Advance the prospect to "pitched" so the funnel/list reflect reality.
  // Guarded to pre-pitch states only (raw/researched) via the WHERE filter, so
  // regenerating a pitch never downgrades a replied/booked/won/lost prospect.
  // The pipeline sets this too; doing it here makes the MANUAL "Generate pitch"
  // button consistent with the automated path.
  await supabase
    .from("prospects")
    .update({
      status: "pitched",
      pitch_gate_passed: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.prospect_id)
    .eq("tenant_id", user.tenantId)
    // b_list included: a B-list prospect re-scored ≥70 gets pitched by the
    // job worker — without advancing it here it kept status b_list and the
    // janitor's 21-day TTL would suppress a prospect with live outreach.
    .in("status", ["raw", "researched", "b_list"]);

  revalidatePath("/pitches");
  revalidatePath("/companies");
  revalidatePath("/funnel");
  revalidatePath(`/companies/${parsed.data.prospect_id}`);

  return {
    ok: true,
    pitch_id: created.id,
    method,
    quality_self_score: composed.quality_self_score,
    reasoning:
      method === "heuristic" && claudeFallbackReason
        ? `${composed.reasoning} (Claude fallback — ${claudeFallbackReason})`
        : composed.reasoning,
  };
}

const rewriteAngleSchema = z.object({
  pitch_id: z.string().uuid(),
  pain_id: z.string().nullable(),
  pain_label: z.string().trim().min(1).max(160),
  case_study_id: z.string().uuid().nullable(),
  capability: z.string().trim().max(80).nullable(),
});

export type RewritePitchResult =
  | { ok: true; subject: string; body: string; quality_self_score: number }
  | { ok: false; error: string };

/**
 * Re-compose an EXISTING pitch led by a human-chosen angle (the "Rewrite with
 * this angle" action on the pitches page). Unlike generatePitch, this never
 * picks its own pain/case — it pins the chosen angle (its pain + that case if
 * one was chosen, else capability-led) and writes the result to body_edited,
 * preserving the original draft in body_original. Claude-only (no template
 * fallback — a template can't honor a specific angle).
 */
export async function rewritePitchWithAngle(
  input: z.input<typeof rewriteAngleSchema>,
): Promise<RewritePitchResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot rewrite pitches." };

  const parsed = rewriteAngleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  if (!claudeIsAvailable()) {
    return { ok: false, error: "Rewrite needs the Anthropic API key, which isn't configured." };
  }

  const supabase = await createClient();

  // Locked pitches can't be rewritten.
  type PitchRow = { id: string; prospect_id: string; status: string };
  const { data: pitch } = await supabase
    .from("pitches")
    .select("id, prospect_id, status")
    .eq("id", parsed.data.pitch_id)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<PitchRow>();
  if (!pitch) return { ok: false, error: "Pitch not found." };
  if (pitch.status === "sent" || pitch.status === "sending") {
    return { ok: false, error: "This pitch was already sent — it can't be rewritten." };
  }

  const cap = await isUnderDailyCap(user.tenantId);
  if (!cap.under) {
    return { ok: false, error: `Daily AI cap hit ($${cap.spent_today_usd.toFixed(2)} of $${cap.cap_usd.toFixed(2)}).` };
  }

  // Load the same inputs generatePitch uses — prospect, research, contacts,
  // the chosen case study (if any), notable clients.
  type ProspectRow = {
    id: string; company_name: string; industry: string | null; language: "en" | "es";
    employee_size_estimate: number | null; city: string | null; market: string | null;
    domain: string | null; website_url: string | null;
  };
  type ResearchRow = { pain_points: unknown; what_they_do: string | null; tech_stack: string[] };

  const [{ data: prospect }, { data: research }, { data: contactRows }] = await Promise.all([
    supabase
      .from("prospects")
      .select("id, company_name, industry, language, employee_size_estimate, city, market, domain, website_url")
      .eq("id", pitch.prospect_id).eq("tenant_id", user.tenantId)
      .maybeSingle<ProspectRow>(),
    supabase
      .from("prospect_research")
      .select("pain_points, what_they_do, tech_stack")
      .eq("prospect_id", pitch.prospect_id).eq("tenant_id", user.tenantId)
      .maybeSingle<ResearchRow>(),
    supabase
      .from("prospect_contacts")
      .select("full_name, email, email_is_role_based, role_title, priority_rank")
      .eq("prospect_id", pitch.prospect_id).eq("tenant_id", user.tenantId)
      .order("priority_rank", { ascending: true }).limit(5)
      .returns<{ full_name: string | null; email: string | null; email_is_role_based: boolean; role_title: string | null }[]>(),
  ]);
  if (!prospect) return { ok: false, error: "Prospect not found." };

  // The chosen case study (only when the angle anchors on one).
  let chosenCases: GeneratorInputCaseStudy[] = [];
  if (parsed.data.case_study_id) {
    type CaseRow = {
      id: string; client_name: string; industry: string | null;
      hero_metric_en: string | null; hero_metric_es: string | null;
      result_description_en: string | null; result_description_es: string | null;
      testimonial_quote_en: string | null; testimonial_quote_es: string | null;
      measurable_results: unknown; tier: "smb" | "mid_market" | "enterprise";
    };
    const { data: cs } = await supabase
      .from("case_studies")
      .select(`id, client_name, industry, hero_metric_en, hero_metric_es, result_description_en, result_description_es, testimonial_quote_en, testimonial_quote_es, measurable_results, tier`)
      .eq("id", parsed.data.case_study_id).eq("tenant_id", user.tenantId)
      .maybeSingle<CaseRow>();
    if (cs) {
      chosenCases = [{
        id: cs.id, client_name: cs.client_name, industry: cs.industry,
        hero_metric_en: cs.hero_metric_en, hero_metric_es: cs.hero_metric_es,
        result_description_en: cs.result_description_en, result_description_es: cs.result_description_es,
        testimonial_quote_en: cs.testimonial_quote_en, testimonial_quote_es: cs.testimonial_quote_es,
        measurable_results: normalizeMeasurableResults(cs.measurable_results),
        pain_strength: 1, tier: cs.tier,
      }];
    }
  }

  let notableClientRows: GeneratorInputNotableClient[] = [];
  try {
    notableClientRows = (await listNotableClients(user.tenantId)).map((nc) => ({
      id: nc.id, name: nc.name, industry_tags: nc.industry_tags, markets: nc.markets,
      relationship_description: nc.relationship_description, key_result: nc.key_result,
      description_en: nc.description_en, description_es: nc.description_es,
    }));
  } catch { /* non-fatal */ }

  const generatorInputs: GeneratorInputs = {
    prospect: { ...prospect, what_they_do: research?.what_they_do ?? null, tech_stack: research?.tech_stack ?? [] },
    pains: normalizePains(research?.pain_points ?? null),
    contacts: (contactRows ?? []).map((c) => ({
      full_name: c.full_name, email: c.email, email_is_role_based: c.email_is_role_based || (c.email ? isRoleBasedEmail(c.email) : false), role_title: c.role_title ?? null,
    })),
    case_studies: chosenCases,
    notable_clients: notableClientRows,
    sender: { full_name: user.fullName, tenant_display_name: user.tenantDisplayName },
    // Hunter CTA leads with the forced angle's pain as the pinned hero finding.
    deep_pitch_url: buildHunterUrlForPitch({
      language: prospect.language,
      market: prospect.market,
      industry: prospect.industry,
      employeeEstimate: prospect.employee_size_estimate,
      painLabel: parsed.data.pain_label,
      techStack: research?.tech_stack ?? [],
      domain: prospect.domain,
      websiteUrl: prospect.website_url,
    }),
    forced_angle: {
      pain_label: parsed.data.pain_label,
      pain_id: parsed.data.pain_id,
      case_study_id: chosenCases.length > 0 ? parsed.data.case_study_id : null,
      capability: parsed.data.capability,
    },
  };

  const result = await composePitchWithClaude(generatorInputs);
  if (!result.ok) {
    return { ok: false, error: `Rewrite failed (${result.reason}). Try again.` };
  }
  const composed = result.result.composed;

  // supabase-js 2.47 narrows the update payload to `never` with our hand-written
  // Database type (see tasks/lessons.md). Cast at the call site; the object above
  // is the real shape.
  const rewriteUpdate = {
    subject: composed.subject,
    body_edited: composed.body,
    preview_text: composed.preview_text,
    pain_id: composed.pain_id,
    case_study_id: composed.case_study_id,
    measurable_result_included: composed.measurable_result_included,
    quality_self_score: composed.quality_self_score,
  };
  const { error: updErr } = await supabase
    .from("pitches")
    .update(rewriteUpdate as never)
    .eq("id", parsed.data.pitch_id)
    .eq("tenant_id", user.tenantId);
  if (updErr) return { ok: false, error: `Could not save rewrite: ${updErr.message}` };

  await recordClaudeCall({
    tenantId: user.tenantId,
    model: result.result.model,
    entity_type: "pitch",
    entity_id: parsed.data.pitch_id,
    usage: { ...result.result.usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    metadata: { kind: "pitch.rewritten_with_angle", pitch_id: parsed.data.pitch_id, pain_label: parsed.data.pain_label, case_study_id: composed.case_study_id },
  });

  revalidatePath("/pitches");
  return { ok: true, subject: composed.subject, body: composed.body, quality_self_score: composed.quality_self_score };
}

/**
 * Save edits to subject/body. Marks body_edited (preserves body_original
 * for audit + rerun comparison).
 */
export async function savePitchEdit(
  input: z.input<typeof editSchema>,
): Promise<PitchActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot edit pitches." };

  const parsed = editSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("pitches")
    .update({
      subject: parsed.data.subject,
      body_edited: parsed.data.body_edited,
    })
    .eq("id", parsed.data.pitch_id)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not save: ${error.message}` };
  revalidatePath("/pitches");
  return { ok: true };
}

/**
 * Status transition. Captures who+when on approval/rejection.
 */
export async function transitionPitchStatus(
  input: z.input<typeof transitionSchema>,
): Promise<PitchActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot change pitch status." };
  }

  const parsed = transitionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  type PitchUpdate = Database["public"]["Tables"]["pitches"]["Update"];
  const payload: PitchUpdate = { status: parsed.data.next_status };

  if (parsed.data.next_status === "queued_for_approval") {
    payload.queued_at = nowIso;
  }
  if (parsed.data.next_status === "approved") {
    payload.approved_by = user.id;
    payload.approved_at = nowIso;
  }
  if (parsed.data.next_status === "reviewer_rejected") {
    payload.rejected_by = user.id;
    payload.rejected_at = nowIso;
    payload.rejection_reason = parsed.data.rejection_reason ?? "no reason given";
  }

  // Look up case_study_id + pain_id BEFORE updating so the audit can
  // record the (case, pain) pair that got rejected. The downrank query
  // reads from audit_log metadata, not pitches (deletes won't lose data).
  let pitchContext: { case_study_id: string | null; pain_id: string | null } = {
    case_study_id: null,
    pain_id: null,
  };
  if (parsed.data.next_status === "reviewer_rejected") {
    const { data: pitchRow } = await supabase
      .from("pitches")
      .select("case_study_id, pain_id")
      .eq("id", parsed.data.pitch_id)
      .eq("tenant_id", user.tenantId)
      .maybeSingle<{ case_study_id: string | null; pain_id: string | null }>();
    if (pitchRow) pitchContext = pitchRow;
  }

  const { error } = await supabase
    .from("pitches")
    .update(payload)
    .eq("id", parsed.data.pitch_id)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not transition: ${error.message}` };

  // Audit-log rejections so the generator's downrank query can see them.
  if (parsed.data.next_status === "reviewer_rejected") {
    await writeAuditLog({
      tenantId: user.tenantId,
      actorId: user.id,
      action: "prospect.scored", // closest existing canonical; Phase 2 adds pitch.rejected
      entityType: "prospect",
      entityId: parsed.data.pitch_id,
      metadata: {
        kind: "pitch.rejected",
        pitch_id: parsed.data.pitch_id,
        case_study_id: pitchContext.case_study_id,
        pain_id: pitchContext.pain_id,
        reason_kind: parsed.data.rejection_reason_kind ?? "other",
        reason_text: parsed.data.rejection_reason ?? null,
      },
    });
  }

  revalidatePath("/pitches");
  return { ok: true };
}

/**
 * Bulk-approve pitches — select several ready drafts and approve them in one go
 * (no one-by-one). Only pitches currently in an approvable state (draft /
 * queued_for_approval) are flipped to 'approved'; already-approved/sent are left
 * untouched. Returns how many actually changed.
 */
const bulkApproveSchema = z.object({
  pitch_ids: z.array(z.string().uuid()).min(1).max(200),
});

export async function bulkApprovePitches(
  input: z.input<typeof bulkApproveSchema>,
): Promise<{ ok: true; approved: number } | { ok: false; error: string }> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot approve pitches." };
  }
  const parsed = bulkApproveSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("pitches")
    .update({ status: "approved", approved_by: user.id, approved_at: nowIso } as never)
    .in("id", parsed.data.pitch_ids)
    .eq("tenant_id", user.tenantId)
    .in("status", ["draft", "queued_for_approval"])
    .select("id");

  if (error) return { ok: false, error: `Could not approve: ${error.message}` };

  revalidatePath("/pitches");
  return { ok: true, approved: (data ?? []).length };
}

/**
 * Read recent rejected-pitch audit entries and return a Map keyed by
 * "<case_study_id>:<pain_id>" → rejection count over last 30 days.
 *
 * Reads from audit_log where metadata.kind = 'pitch.rejected' (Layer 4,
 * 2026-04-27). We use audit_log instead of pitches.rejected_at so the
 * signal survives prospect or pitch deletion.
 */
async function loadRejectionCountsByCasePain(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  painId: string | null,
): Promise<Map<string, number>> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  type Row = { metadata: Record<string, unknown> | null };
  const { data, error } = await supabase
    .from("audit_log")
    .select("metadata")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "prospect")
    .eq("metadata->>kind", "pitch.rejected")
    .gte("created_at", cutoff)
    .returns<Row[]>();
  if (error) {
    console.warn(`[generatePitch] rejection-count query failed: ${error.message}`);
    return new Map();
  }
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const m = row.metadata ?? {};
    const cs = typeof m.case_study_id === "string" ? m.case_study_id : null;
    const p = typeof m.pain_id === "string" ? m.pain_id : null;
    // Only count rejections that match the pain we're scoring against
    // (or with no pain — those penalize the case for any pain).
    if (!cs) continue;
    if (painId && p && p !== painId) continue;
    const key = `${cs}:${painId ?? ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Apply rejection penalty to a case's pain_strength. -0.1 per rejection,
 * floor at 0. Null strength stays null (not tagged for this pain).
 */
function applyRejectionDownrank(
  strength: number | null,
  rejections: number,
): number | null {
  if (strength === null) return null;
  if (rejections === 0) return strength;
  return Math.max(0, strength - 0.1 * rejections);
}

function normalizeMeasurableResults(
  raw: unknown,
): { metric?: string; label?: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    const out: { metric?: string; label?: string } = {};
    if (typeof e.metric === "string") out.metric = e.metric;
    if (typeof e.label === "string") out.label = e.label;
    return out.metric || out.label ? [out] : [];
  });
}

function normalizePains(raw: unknown): GeneratorInputResearchPain[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    const pain_id = typeof e.pain_id === "string" ? e.pain_id : null;
    const pain_label = typeof e.pain_label === "string" ? e.pain_label.trim() : null;

    // ── Evidence-quote gate (mirrors score-action normalizePainPoints) ───────
    // Only pains with a real scraped quote reach the pitch generator.
    // Filters: quote must exist, be ≥20 chars, and not be a recycled copy of
    // the pain label (the Claude fallback anti-pattern).
    const evidence_quote =
      typeof e.evidence_quote === "string" ? e.evidence_quote.trim() : null;
    if (!evidence_quote || evidence_quote.length < 20 || evidence_quote === pain_label) {
      return [];
    }

    if (!pain_id && !pain_label) return [];
    return [{ pain_id, pain_label, evidence_quote }];
  });
}
