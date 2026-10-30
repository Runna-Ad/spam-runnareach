import { revalidatePath } from "next/cache";
import {
  checkPitchGate,
  loadGateShared,
  refreshGateAfterChange,
  type StoredGateVerdict,
} from "@/lib/pitches/gate";
import { GATE_SEVERITY, describeFailures, gateAllows, type GateFailure } from "@/lib/pitches/send-gate";
import { z } from "zod";
import { ANTHROPIC_DEFAULT_MODEL, claudeIsAvailable, type ClaudeUsage } from "@/lib/anthropic/client";
import { isUnderDailyCap, recordClaudeCall } from "@/lib/anthropic/cost-tracking";
import { writeAuditLog } from "@/lib/audit/log";
import type { Actor } from "@/lib/actor";
import type { Database } from "@/lib/supabase/types";
import { PITCH_PROMPT_VERSION, SHOWCASE_PROMPT_VERSION, isAdviceQuote } from "./claude-composer";
import { composeWithReview, type ReviewCall, type WantedFacts } from "./review";
import {
  DECISION_VERSION,
  detectCitedBenchmark,
  newAttributionCode,
  recipientSummary,
  registerFor,
  sizeBand,
  type CriticVerdict,
  type DecisionRecord,
} from "./decision";
import { recordPitchEvent } from "./events";
import { allowedFrom, transitionRefusedMessage, transitionVerdict } from "./status-transitions";
import { fetchExemplars } from "./exemplar-queries";
import { decisionExemplarFields } from "./exemplars";
import { segmentOf } from "@/lib/learning/segments";
import { chooseWriterArms, isShowcaseArm, type ShowcaseArm } from "@/lib/autopilot/learn";
import { pickBuilds } from "@/lib/runna/builds";
import { renderIndustryTemplate } from "./industry-templates";
import { buildHunterUrlForPitch } from "./hunter-mapping";
import { senderForGenerator } from "./sender-identity";
import { hasUsableEmail, isRoleBasedEmail } from "@/lib/research/email-utils";
import { fetchBenchmarksForPitch, resolvePainCodes } from "@/lib/benchmarks/queries";
import { recordWantedFacts } from "@/lib/benchmarks/wanted-facts";
import { chooseRecipient, type VerdictContact } from "@/lib/pitches/contacts";
import {
  type ComposedPitch,
  type GeneratorInputContact,
  type GeneratorInputCaseStudy,
  type GeneratorInputNotableClient,
  type GeneratorInputResearchPain,
  type GeneratorInputs,
} from "./generator";
import { listNotableClients } from "@/lib/notable-clients/queries";
import { isSentOrParked } from "@/lib/prospects/status";

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
  /**
   * Review-level gate codes the person read and accepts ("Approve anyway").
   * Block-level codes are never accepted, whatever is sent here.
   */
  accept_gate_codes: z.array(z.string().max(60)).max(20).optional(),
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

export type PitchActionResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** Set when the send gate refused: the failures still standing. */
      gate?: { outstanding: GateFailure[]; verdict: StoredGateVerdict };
    };

/**
 * Generate a draft pitch for a prospect. Reads research + contacts +
 * case_studies, runs the heuristic composer, persists to pitches.
 *
 * The actor is explicit (lib/actor.ts): the pipeline and the autopilot pass
 * theirs; the browser-facing generatePitch action passes the session's. (It
 * used to accept an injected user from its caller, which a browser could
 * forge, since every "use server" export is callable with any arguments.)
 */
export async function generatePitchWith(
  actor: Actor,
  prospectId: string,
  // Only the autopilot passes this (the browser wrapper takes a prospect id).
  // redraftOf: the autopilot's re-draft pool (lib/autopilot/tick.ts), written in the
  // decision record at its first write (pitches.decision is write-once, 0038).
  opts: { retryOf?: string; redraftOf?: string } = {},
): Promise<GeneratePitchResult> {
  const { user } = actor;
  const { supabase } = actor;

  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot generate pitches." };
  }

  const parsed = generateSchema.safeParse({ prospect_id: prospectId });
  if (!parsed.success) return { ok: false, error: "Invalid prospect id." };
  // The server action has 60s; the write → review → revise loop gets what's left.
  const startedAt = Date.now();

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

  const pains: GeneratorInputResearchPain[] = normalizePains(research?.pain_points ?? null, prospect.company_name);

  // Load contacts — include role_title so Claude can address "as founder/GM of..."
  type ContactRow = VerdictContact & {
    id: string;
    full_name: string | null;
    email: string | null;
    email_is_role_based: boolean;
    role_title: string | null;
    priority_rank: number;
  };
  const { data: contactRows } = await supabase
    .from("prospect_contacts")
    // chooseRecipient's columns (contacts.ts RECIPIENT_COLUMNS) plus the composer's.
    .select("id, email, full_name, priority_rank, selected_by, verify_verdict, verify_checked_at, email_is_role_based, role_title")
    .eq("tenant_id", user.tenantId)
    .eq("prospect_id", parsed.data.prospect_id)
    .order("priority_rank", { ascending: true })
    .limit(12)
    .returns<ContactRow[]>();
  // ── The recipient, chosen once (lib/pitches/contacts.ts chooseRecipient) ──
  // Every composer and the reviewer greet pickAddressContact (the first usable
  // contact in this list), and the pitch is linked to `recipient` below: they
  // must be the same person. When the rule picks someone other than the first
  // usable of the top five (the verifier flagged that one), that contact leads
  // the list; otherwise the list is exactly the top five, as before (none
  // usable there is still refused below).
  const recipient = chooseRecipient(contactRows, new Date());
  const topFive = (contactRows ?? []).slice(0, 5);
  const firstUsable = topFive.find((c) => hasUsableEmail(c.email));
  const listed =
    !recipient || !firstUsable || firstUsable.id === recipient.id
      ? topFive
      : [recipient, ...topFive.filter((c) => c.id !== recipient.id)].slice(0, 5);
  const contacts: GeneratorInputContact[] = listed.map((c) => ({
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
    const allClients = await listNotableClients(user.tenantId, undefined, supabase);

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

  // Verified benchmarks for this prospect's pains AND industry (or industry
  // family), each tagged with the pains it is about. Empty is normal and
  // safe — with none, the composer writes the pitch without a number.
  // Never throws; a benchmark is an enhancement, not a dependency.
  const benchmarks = await fetchBenchmarksForPitch(supabase, user.tenantId, {
    painIds: pains.map((p) => p.pain_id).filter((v): v is string => Boolean(v)),
    industry: prospect.industry,
    market: prospect.market,
  });

  // Carried in the audit-tool link (&r=) so a scan can be tied to this pitch.
  const attributionCode = newAttributionCode();

  // Which writer variants this pitch tests (lib/autopilot/learn.ts): cite a
  // sourced statistic or not, and which learned guidance (if any) to follow.
  // Never throws; without arms, today's behaviour.
  // Alongside: up to two of our own best past pitches for this segment
  // (lib/pitches/exemplars.ts), scrubbed, as the writer's model and the
  // critic's bar. Never throws; none → today's exact prompts. Skipped when the
  // daily AI cap is already hit (the template writes the pitch then), so the
  // cap is checked once, here, and reused below.
  // ── The autopilot's rewrite composes FRESH (writer-honesty, 2026-10-26) ──
  // It used to revise the held draft's text against its notes: since batch 6
  // revised rewrites were sent or approved 7 of 59 times (12%), fresh ones 3
  // of 11 (27%), and a revision carries the held text's claims (and its
  // attribution code) into the new draft. The held row is read only for its
  // re-draft mark and its showcase arm, BEFORE the draft delete below clears it.
  // A re-draft's rewrite is still that re-draft: its mark comes with it.
  // It keeps the held draft's showcase arm too: re-rolling it would move the
  // drafts the critic holds more often over to the other style, and the test
  // would compare survivors instead of styles.
  let redraftOf: string | undefined = opts.redraftOf;
  let heldShowcase: ShowcaseArm | null = null;
  if (opts.retryOf) {
    const { data: held, error: heldErr } = await supabase
      .from("pitches")
      .select("decision")
      .eq("id", opts.retryOf)
      .eq("tenant_id", user.tenantId)
      .eq("prospect_id", parsed.data.prospect_id)
      .maybeSingle<{ decision: unknown }>();
    if (heldErr) console.warn("[generatePitch] held draft not read:", heldErr.message || "no message");
    const heldDecision = held?.decision as { redraft_of?: unknown; arms?: Record<string, unknown> } | null | undefined;
    const heldMark = heldDecision?.redraft_of;
    if (!redraftOf && typeof heldMark === "string" && heldMark) redraftOf = heldMark;
    const arm = heldDecision?.arms?.["writer.showcase"];
    if (isShowcaseArm(arm)) heldShowcase = arm;
  }

  // The showcase email (writer.showcase "first", lib/runna/builds.ts) is its
  // own style: real builds instead of a pain, so no benchmarks, no learned
  // guidance (tuned on the pain-led email) and no exemplars, which are then
  // never fetched.
  const dailyCapCheck = claudeIsAvailable() ? isUnderDailyCap(user.tenantId) : Promise.resolve(null);
  const armsCheck = chooseWriterArms(supabase, user.tenantId);
  const showcaseCheck = armsCheck.then((a) =>
    (heldShowcase ?? a.showcase) === "first"
      ? pickBuilds({ industry: prospect.industry, what_they_do: research?.what_they_do ?? null, lang: prospect.language })
      : [],
  );
  const [writerArms, showcaseBuilds, exemplars, dailyCap] = await Promise.all([
    armsCheck,
    showcaseCheck,
    Promise.all([dailyCapCheck, showcaseCheck]).then(([c, builds]) =>
      c?.under && builds.length === 0
        ? fetchExemplars(supabase, user.tenantId, {
            segment: segmentOf(prospect),
            lang: prospect.language,
            prospect_id: prospect.id,
          })
        : [],
    ),
    dailyCapCheck,
  ]);
  const showcaseFirst = showcaseBuilds.length > 0;
  const offeredBenchmarks = showcaseFirst || writerArms.evidence === "no_benchmark" ? [] : benchmarks;

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
    benchmarks: offeredBenchmarks,
    guidance: showcaseFirst ? null : (writerArms.guidance?.text ?? null),
    exemplars,
    showcase_builds: showcaseFirst ? showcaseBuilds : null,
    // Signed by the per-language sender (Nils ES / Henry EN · Runna Advertising),
    // never the name of whoever clicked "Generate".
    sender: senderForGenerator(prospect.language),
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
      ref: attributionCode,
    }),
  };

  // ── PHASE 2: try Claude first, fall back to heuristic ─────────────────
  // Claude path requires both an API key AND headroom under the daily
  // spend cap. Any failure (network, parse, schema, cap) drops through
  // to the deterministic heuristic so the user still gets a draft.
  let composed: ComposedPitch | null = null;
  let method: "heuristic" | "claude" = "heuristic";
  let claudeUsage: ClaudeUsage | null = null;
  let claudeModel: string | null = null;
  let claudeFallbackReason: string | null = null;
  // Every Claude call the write → review → revise loop made, for cost tracking.
  let reviewCalls: ReviewCall[] = [];
  let critic: CriticVerdict | null = null;
  // The kept draft's wishes for a statistic the library lacks (Claude path only).
  let wanted: WantedFacts | null = null;

  // ── Status re-check, immediately before any Claude call ───────────────
  // Everything above took seconds of awaits; a pipeline job works through its
  // ids over many slices, so a company can be suppressed, booked or won in the
  // meantime. The pipeline's status write would then refuse the pitch, after
  // Claude was paid for it and a draft no one may send was left behind. Read
  // fresh and fail closed: an error or a missing row refuses too.
  // A company already emailed (sent, bounced, replied, ghosted) is refused as
  // well: a second first-touch pitch to it is never right. The manual button
  // was the one path that could draft one. A drafted-but-unsent company
  // (pitched, queued, approved) still may: the autopilot's rewrite needs that.
  const { data: fresh, error: freshErr } = await supabase
    .from("prospects")
    .select("status")
    .eq("id", parsed.data.prospect_id)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<{ status: string }>();
  if (freshErr) return { ok: false, error: `Status re-check failed: ${freshErr.message || "no message"}` };
  if (!fresh) return { ok: false, error: "Prospect not found." };
  if (isSentOrParked(fresh.status)) {
    return { ok: false, error: `Not generating: the company is ${fresh.status} (already emailed or do not send).` };
  }

  if (dailyCap) {
    const cap = dailyCap;
    if (!cap.under) {
      claudeFallbackReason = `daily cap hit (spent $${cap.spent_today_usd.toFixed(2)} of $${cap.cap_usd.toFixed(2)})`;
    } else {
      const reviewed = await composeWithReview(generatorInputs, { deadline: startedAt + 48_000 });
      reviewCalls = reviewed.calls;
      if (reviewed.ok) {
        composed = reviewed.composed;
        method = "claude";
        claudeModel = reviewed.model;
        critic = reviewed.critic;
        // The no_benchmark arm hides the library from the writer and critic on
        // purpose: a wish there is for a statistic we may well have, not a gap.
        // The decision still keeps the writer's wish (it is labelled with the arm).
        wanted = showcaseFirst || writerArms.evidence === "no_benchmark" ? null : reviewed.wanted;
        claudeUsage = sumUsage(reviewed.calls.map((c) => c.usage));
      } else {
        claudeFallbackReason = `${reviewed.reason}: ${reviewed.error.slice(0, 200)}`;
        // Failed calls can still cost tokens — record them so the daily cap
        // stays honest.
        for (const c of reviewed.calls) {
          await recordClaudeCall({
            tenantId: user.tenantId,
            model: c.model === "unknown" ? ANTHROPIC_DEFAULT_MODEL : c.model,
            entity_type: "pitch",
            entity_id: parsed.data.prospect_id,
            usage: c.usage,
            metadata: { fallback: true, kind: c.kind, reason: reviewed.reason, error: reviewed.error.slice(0, 500) },
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

  // Link the FK to the recipient chosen above, the contact the text greets
  // (a usable one, never a name-only/placeholder row).
  const topUsable = recipient?.email
    ? { id: recipient.id, email: recipient.email, full_name: recipient.full_name, selected_by: recipient.selected_by ?? null }
    : null;

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
  const insertWithPreview = {
    ...insert,
    preview_text: composed.preview_text,
    // Only set when the code actually made it into the email's link.
    attribution_code: composed.body.includes(attributionCode) ? attributionCode : null,
  };

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

  // Wanted facts: started now (it needs the pitch id), awaited only at the very
  // end, so it runs alongside the steps below. Never throws, settles in ~3.5 s.
  const wantedRecording = wanted
    ? recordWantedFactsForPitch(supabase, user.tenantId, created.id, prospect, composed.pain_id, wanted)
    : Promise.resolve(0);

  // Record each Claude call's cost (writer and critic are different models).
  // Failures were recorded earlier, in the fallback branch.
  if (method === "claude") {
    for (const c of reviewCalls) {
      await recordClaudeCall({
        tenantId: user.tenantId,
        model: c.model === "unknown" ? ANTHROPIC_DEFAULT_MODEL : c.model,
        entity_type: "pitch",
        entity_id: created.id,
        usage: c.usage,
        metadata: { pitch_id: created.id, prospect_id: parsed.data.prospect_id, kind: c.kind },
      });
    }
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

  // Send gate v2: store the verdict so /pitches shows what needs fixing before
  // anyone tries to approve. Approve and send re-check; this is for display.
  const gateAtGeneration = await refreshGateAfterChange(supabase, user.tenantId, created.id);

  // Decision record: written once (a trigger refuses later changes), so every
  // later outcome can be traced to what was decided here.
  const band = sizeBand(prospect.employee_size_estimate);
  const decision: DecisionRecord = {
    v: DECISION_VERSION,
    created_at: new Date().toISOString(),
    path: method === "claude" ? "claude" : "template",
    prompt_version: method === "claude" ? (showcaseFirst ? SHOWCASE_PROMPT_VERSION : PITCH_PROMPT_VERSION) : "industry-templates",
    model: method === "claude" ? claudeModel : null,
    fallback_reason: claudeFallbackReason,
    lang: prospect.language,
    register: registerFor(prospect.language, band),
    segment: { industry: prospect.industry, market: prospect.market, size_band: band },
    pain: {
      id: composed.pain_id,
      label: pains.find((p) => p.pain_id && p.pain_id === composed.pain_id)?.pain_label ?? chosenPainLabel,
    },
    benchmarks_offered: offeredBenchmarks.map((b) => ({
      id: b.id,
      figure: b.figure,
      pain_codes: b.for_pains.map((f) => f.code),
    })),
    benchmark_cited: detectCitedBenchmark(composed.body, offeredBenchmarks),
    attribution_code: insertWithPreview.attribution_code,
    recipient: recipientSummary(
      topUsable
        ? { ...topUsable, email_is_role_based: isRoleBasedEmail(topUsable.email) }
        : null,
    ),
    critic,
    gate: gateAtGeneration
      ? { version: gateAtGeneration.version, pass: gateAtGeneration.pass, codes: gateAtGeneration.failures.map((f) => f.code) }
      : null,
    // Only an AI-written pitch tests writer variants; a template tests nothing.
    // The showcase email tests only where the builds go; the pain-led one tests
    // its evidence and guidance too, and carries the builds into follow-up #1.
    ...(method === "claude"
      ? showcaseFirst
        ? {
            arms: { "writer.showcase": "first" },
            builds_offered: showcaseBuilds.map((b) => b.id),
            builds_used: composed.builds_used ?? [],
          }
        : {
            arms: {
              "writer.evidence": writerArms.evidence,
              "writer.guidance": writerArms.guidance?.key ?? "none",
              "writer.showcase": "followup",
            },
          }
      : {}),
    // A template uses no exemplars, even when some were loaded for the AI path.
    ...decisionExemplarFields(method === "claude" ? "claude" : "template", exemplars),
    ...(opts.retryOf
      ? { retry_of: opts.retryOf, retry_mode: "fresh" as const }
      : {}),
    ...(redraftOf ? { redraft_of: redraftOf } : {}),
    ...(method === "claude" && !showcaseFirst ? { wanted_fact: composed.wanted_fact ?? null } : {}),
  };
  const { error: decisionErr } = await supabase
    .from("pitches")
    .update({ decision } as never)
    .eq("id", created.id)
    .eq("tenant_id", user.tenantId);
  if (decisionErr) console.warn("[generatePitch] decision record not saved:", decisionErr.message);
  await recordPitchEvent(supabase, {
    tenantId: user.tenantId,
    pitchId: created.id,
    type: "generated",
    payload: {
      path: decision.path,
      prompt_version: decision.prompt_version,
      critic_pass: critic?.pass ?? null,
      revisions: critic?.revisions ?? 0,
      benchmark_cited: decision.benchmark_cited?.figure ?? null,
      gate_pass: decision.gate?.pass ?? null,
    },
  });

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

  await wantedRecording;

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

/**
 * Record the kept draft's wanted facts against a saved pitch, tied to the pain
 * the writer led with (resolved to its pain_taxonomy code) and the prospect's
 * segment. Best-effort (lib/benchmarks/wanted-facts.ts): never throws.
 */
async function recordWantedFactsForPitch(
  supabase: Actor["supabase"],
  tenantId: string,
  pitchId: string,
  prospect: { company_name: string; industry: string | null; market: string | null },
  painId: string | null,
  wanted: WantedFacts,
): Promise<number> {
  try {
    return await recordWantedFacts(supabase, {
      tenantId,
      pitchId,
      companyName: prospect.company_name,
      industry: prospect.industry,
      market: prospect.market,
      writer: wanted.writer,
      critic: wanted.critic,
      painCode: async () => (painId ? ((await resolvePainCodes(supabase, tenantId, [painId]))[0]?.code ?? null) : null),
    });
  } catch (e) {
    console.warn("[wanted-facts] not recorded:", e instanceof Error ? e.message : String(e));
    return 0;
  }
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
export async function rewritePitchWithAngleWith(
  actor: Actor,
  input: z.input<typeof rewriteAngleSchema>,
): Promise<RewritePitchResult> {
  const { user } = actor;
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot rewrite pitches." };

  const parsed = rewriteAngleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  if (!claudeIsAvailable()) {
    return { ok: false, error: "Rewrite needs the Anthropic API key, which isn't configured." };
  }

  const { supabase } = actor;

  // Locked pitches can't be rewritten.
  type PitchRow = { id: string; prospect_id: string; contact_id: string | null; status: string; attribution_code: string | null };
  const { data: pitch } = await supabase
    .from("pitches")
    .select("id, prospect_id, contact_id, status, attribution_code")
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
      .select("id, full_name, email, email_is_role_based, role_title, priority_rank")
      .eq("prospect_id", pitch.prospect_id).eq("tenant_id", user.tenantId)
      .order("priority_rank", { ascending: true }).limit(12)
      .returns<{ id: string; full_name: string | null; email: string | null; email_is_role_based: boolean; role_title: string | null }[]>(),
  ]);
  if (!prospect) return { ok: false, error: "Prospect not found." };
  // The rewrite greets the pitch's own recipient: when its contact is usable
  // and not already the first usable of the top five (a contact chosen past a
  // flagged one), it leads the list; otherwise the list is the top five, as before.
  const topFive = (contactRows ?? []).slice(0, 5);
  const own = (contactRows ?? []).find((c) => c.id === pitch.contact_id && hasUsableEmail(c.email));
  const firstUsable = topFive.find((c) => hasUsableEmail(c.email));
  const listed = own && firstUsable && own.id !== firstUsable.id ? [own, ...topFive.filter((c) => c.id !== own.id)].slice(0, 5) : topFive;

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
    notableClientRows = (await listNotableClients(user.tenantId, undefined, supabase)).map((nc) => ({
      id: nc.id, name: nc.name, industry_tags: nc.industry_tags, markets: nc.markets,
      relationship_description: nc.relationship_description, key_result: nc.key_result,
      description_en: nc.description_en, description_es: nc.description_es,
    }));
  } catch { /* non-fatal */ }

  // Same benchmark lookup as first generation — the rewrite path must follow
  // the same rules, or "rewrite with this angle" quietly produces a pitch the
  // normal path could not.
  const rewritePains = normalizePains(research?.pain_points ?? null, prospect.company_name);
  const rewriteBenchmarks = await fetchBenchmarksForPitch(supabase, user.tenantId, {
    painIds: rewritePains.map((p) => p.pain_id).filter((v): v is string => Boolean(v)),
    industry: prospect.industry,
    market: prospect.market,
  });

  const generatorInputs: GeneratorInputs = {
    prospect: { ...prospect, what_they_do: research?.what_they_do ?? null, tech_stack: research?.tech_stack ?? [] },
    pains: rewritePains,
    benchmarks: rewriteBenchmarks,
    contacts: listed.map((c) => ({
      full_name: c.full_name, email: c.email, email_is_role_based: c.email_is_role_based || (c.email ? isRoleBasedEmail(c.email) : false), role_title: c.role_title ?? null,
    })),
    case_studies: chosenCases,
    notable_clients: notableClientRows,
    sender: senderForGenerator(prospect.language),
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
      // Keep the pitch's attribution code so a scan from the rewritten email
      // still traces back to it.
      ref: pitch.attribution_code,
    }),
    forced_angle: {
      pain_label: parsed.data.pain_label,
      pain_id: parsed.data.pain_id,
      case_study_id: chosenCases.length > 0 ? parsed.data.case_study_id : null,
      capability: parsed.data.capability,
    },
  };

  // Same write → review → revise loop as first generation.
  const result = await composeWithReview(generatorInputs, { deadline: Date.now() + 45_000 });
  if (!result.ok) {
    for (const c of result.calls) {
      await recordClaudeCall({
        tenantId: user.tenantId,
        model: c.model === "unknown" ? ANTHROPIC_DEFAULT_MODEL : c.model,
        entity_type: "pitch",
        entity_id: parsed.data.pitch_id,
        usage: c.usage,
        metadata: { kind: "pitch.rewritten_with_angle", failed: true, step: c.kind },
      });
    }
    return { ok: false, error: `Rewrite failed (${result.reason}). Try again.` };
  }
  const composed = result.composed;

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
  const wantedRecording = recordWantedFactsForPitch(
    supabase, user.tenantId, parsed.data.pitch_id, prospect, composed.pain_id, result.wanted,
  );
  await refreshGateAfterChange(supabase, user.tenantId, parsed.data.pitch_id);

  for (const c of result.calls) {
    await recordClaudeCall({
      tenantId: user.tenantId,
      model: c.model === "unknown" ? ANTHROPIC_DEFAULT_MODEL : c.model,
      entity_type: "pitch",
      entity_id: parsed.data.pitch_id,
      usage: c.usage,
      metadata: { kind: "pitch.rewritten_with_angle", step: c.kind, pitch_id: parsed.data.pitch_id, pain_label: parsed.data.pain_label },
    });
  }
  // The decision record describes the first writing and is write-once; a
  // rewrite is an event on the pitch's history instead.
  await recordPitchEvent(supabase, {
    tenantId: user.tenantId,
    pitchId: parsed.data.pitch_id,
    type: "generated",
    payload: {
      path: "rewrite",
      prompt_version: PITCH_PROMPT_VERSION,
      angle: parsed.data.pain_label,
      // A human-chosen angle is written without exemplars.
      exemplars_used: [],
      critic_pass: result.critic?.pass ?? null,
      critic_issues: result.critic?.issues ?? [],
      revisions: result.critic?.revisions ?? 0,
    },
  });

  await wantedRecording;

  revalidatePath("/pitches");
  return { ok: true, subject: composed.subject, body: composed.body, quality_self_score: composed.quality_self_score };
}

/**
 * Save edits to subject/body. Marks body_edited (preserves body_original
 * for audit + rerun comparison).
 */
export async function savePitchEditWith(
  actor: Actor,
  input: z.input<typeof editSchema>,
): Promise<PitchActionResult> {
  const { user } = actor;
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot edit pitches." };

  const parsed = editSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const { supabase } = actor;
  const { error } = await supabase
    .from("pitches")
    .update({
      subject: parsed.data.subject,
      body_edited: parsed.data.body_edited,
    })
    .eq("id", parsed.data.pitch_id)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not save: ${error.message}` };
  // The edited text gets a fresh verdict, and any "approve anyway" is dropped:
  // it accepted flags on text that no longer exists.
  await refreshGateAfterChange(supabase, user.tenantId, parsed.data.pitch_id);
  revalidatePath("/pitches");
  return { ok: true };
}

/**
 * Status transition. Captures who+when on approval/rejection.
 * The from-state is enforced in the UPDATE's WHERE (status-transitions.ts): a
 * stale tab can't reject a claimed pitch or send a sent one back to draft.
 */
export async function transitionPitchStatusWith(
  actor: Actor,
  input: z.input<typeof transitionSchema>,
): Promise<PitchActionResult> {
  const { user } = actor;
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot change pitch status." };
  }

  const parsed = transitionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const { supabase } = actor;
  const next = parsed.data.next_status;

  // The current row: same status is a no-op (double-click, autopilot re-run);
  // a refused move fails before the gate runs. The WHERE below still decides.
  const { data: current, error: readErr } = await supabase
    .from("pitches")
    .select("status, case_study_id, pain_id")
    .eq("id", parsed.data.pitch_id)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<{ status: string; case_study_id: string | null; pain_id: string | null }>();
  if (readErr) return { ok: false, error: `Could not transition: ${readErr.message}` };
  if (!current) return { ok: false, error: "Pitch not found." };
  const verdict = transitionVerdict(current.status, next);
  if (verdict === "noop") return { ok: true };
  if (verdict === "refused") return { ok: false, error: transitionRefusedMessage(current.status) };

  const nowIso = new Date().toISOString();
  type PitchUpdate = Database["public"]["Tables"]["pitches"]["Update"];
  const payload: PitchUpdate = { status: next };

  if (parsed.data.next_status === "queued_for_approval") {
    payload.queued_at = nowIso;
  }
  // ── Send gate v2 at approve ────────────────────────────────────────────────
  // Approving is a promise the email may go out. Block-level failures (an
  // invented number, a client name, a broken link) can't be approved at all;
  // review-level ones need the person to accept each flag by code.
  let acceptedOverride: { by: string; at: string; codes: string[] } | null = null;
  if (parsed.data.next_status === "approved") {
    const check = await checkPitchGate(supabase, user.tenantId, parsed.data.pitch_id);
    if (!check) {
      return { ok: false, error: "Couldn't run the quality check on this pitch. Try again." };
    }
    const accepted = (parsed.data.accept_gate_codes ?? []).filter(
      (c) => (GATE_SEVERITY as Record<string, string>)[c] === "review",
    );
    const allowed = gateAllows(check.result, accepted);
    if (!allowed.ok) {
      const blocking = allowed.outstanding.filter((f) => f.severity === "block");
      return {
        ok: false,
        error: blocking.length
          ? `Fix before approving: ${describeFailures(blocking)}`
          : `Needs a look before approving: ${describeFailures(allowed.outstanding)}`,
        gate: { outstanding: allowed.outstanding, verdict: check.verdict },
      };
    }
    const reviewCodes = check.result.pass ? [] : check.result.failures.map((f) => f.code);
    acceptedOverride = reviewCodes.length ? { by: user.id, at: nowIso, codes: reviewCodes } : null;
    payload.approved_by = user.id;
    payload.approved_at = nowIso;
  }
  if (parsed.data.next_status === "reviewer_rejected") {
    payload.rejected_by = user.id;
    payload.rejected_at = nowIso;
    payload.rejection_reason = parsed.data.rejection_reason ?? "no reason given";
  }

  // case_study_id + pain_id read BEFORE updating so the audit can record the
  // (case, pain) pair that got rejected. The downrank query reads from
  // audit_log metadata, not pitches (deletes won't lose data).
  const pitchContext = { case_study_id: current.case_study_id, pain_id: current.pain_id };

  const { data: moved, error } = await supabase
    .from("pitches")
    .update(
      (parsed.data.next_status === "approved"
        ? { ...payload, gate_override: acceptedOverride }
        : payload) as never,
    )
    .eq("id", parsed.data.pitch_id)
    .eq("tenant_id", user.tenantId)
    .in("status", allowedFrom(next))
    .select("id");

  if (error) return { ok: false, error: `Could not transition: ${error.message}` };
  if (!moved || moved.length === 0) {
    // The row moved since the read (the queue claimed it, someone else acted).
    const { data: now, error: rereadErr } = await supabase
      .from("pitches")
      .select("status")
      .eq("id", parsed.data.pitch_id)
      .eq("tenant_id", user.tenantId)
      .maybeSingle<{ status: string }>();
    if (rereadErr) return { ok: false, error: `Nothing was changed, and the pitch couldn't be re-read: ${rereadErr.message}` };
    if (!now) return { ok: false, error: "Pitch not found." };
    if (now.status === next) return { ok: true };
    return { ok: false, error: transitionRefusedMessage(now.status) };
  }

  if (parsed.data.next_status === "approved") {
    await recordPitchEvent(supabase, {
      tenantId: user.tenantId,
      pitchId: parsed.data.pitch_id,
      type: "approved",
      payload: { by: user.id, accepted_gate_codes: acceptedOverride?.codes ?? [], autopilot: actor.system },
    });
  }

  if (acceptedOverride) {
    await writeAuditLog({
      tenantId: user.tenantId,
      actorId: user.id,
      action: "pitch.gate_override",
      entityType: "pitch",
      entityId: parsed.data.pitch_id,
      metadata: { accepted_codes: acceptedOverride.codes },
    });
  }

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

export async function bulkApprovePitchesWith(
  actor: Actor,
  input: z.input<typeof bulkApproveSchema>,
): Promise<
  | { ok: true; approved: number; skipped_no_contact: number; skipped_gate: number }
  | { ok: false; error: string }
> {
  const { user } = actor;
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot approve pitches." };
  }
  const parsed = bulkApproveSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const { supabase } = actor;

  // ── Skip pitches we could never send ──────────────────────────────────────
  // Approving is a promise that the pitch is ready to go out. A pitch whose
  // prospect has no usable email can't be queued (the send queue requires a
  // contact_id) so approving it just parks it in the queue forever, looking
  // ready. That is exactly how 11 unsendable drafts reached "Approved".
  type PitchRow = { id: string; prospect_id: string };
  const { data: candidates } = await supabase
    .from("pitches")
    .select("id, prospect_id")
    .in("id", parsed.data.pitch_ids)
    .eq("tenant_id", user.tenantId)
    .in("status", ["draft", "queued_for_approval"])
    .returns<PitchRow[]>();

  const prospectIds = Array.from(new Set((candidates ?? []).map((p) => p.prospect_id)));
  type ContactRow = { prospect_id: string; email: string | null };
  const { data: contactRows } = prospectIds.length
    ? await supabase
        .from("prospect_contacts")
        .select("prospect_id, email")
        .in("prospect_id", prospectIds)
        .eq("tenant_id", user.tenantId)
        .returns<ContactRow[]>()
    : { data: [] as ContactRow[] };

  const reachable = new Set(
    (contactRows ?? []).filter((c) => hasUsableEmail(c.email)).map((c) => c.prospect_id),
  );
  const approvable = (candidates ?? []).filter((p) => reachable.has(p.prospect_id));
  const skippedNoContact = (candidates ?? []).length - approvable.length;

  if (approvable.length === 0) {
    return { ok: true, approved: 0, skipped_no_contact: skippedNoContact, skipped_gate: 0 };
  }

  // ── Send gate v2 ──────────────────────────────────────────────────────────
  // Bulk approve never accepts a flag on the person's behalf: only pitches the
  // gate passes outright are approved. Flagged ones stay drafts with their
  // verdict stored, to be read and approved one by one. (v1 bulk-approved up
  // to 200 at once with only a contact check.)
  const shared = await loadGateShared(supabase, user.tenantId);
  if (!shared) return { ok: false, error: "Couldn't run the quality check. Try again." };
  const passing: string[] = [];
  for (let i = 0; i < approvable.length; i += 10) {
    const batch = approvable.slice(i, i + 10);
    const checks = await Promise.all(
      batch.map((p) => checkPitchGate(supabase, user.tenantId, p.id, { shared })),
    );
    checks.forEach((c, j) => {
      if (c?.result.pass) passing.push(batch[j]!.id);
    });
  }
  const skippedGate = approvable.length - passing.length;
  if (passing.length === 0) {
    revalidatePath("/pitches");
    return { ok: true, approved: 0, skipped_no_contact: skippedNoContact, skipped_gate: skippedGate };
  }

  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("pitches")
    .update({ status: "approved", approved_by: user.id, approved_at: nowIso, gate_override: null } as never)
    .in("id", passing)
    .eq("tenant_id", user.tenantId)
    .in("status", ["draft", "queued_for_approval"])
    .select("id");

  if (error) return { ok: false, error: `Could not approve: ${error.message}` };

  for (const row of (data ?? []) as { id: string }[]) {
    await recordPitchEvent(supabase, {
      tenantId: user.tenantId,
      pitchId: row.id,
      type: "approved",
      payload: { by: user.id, bulk: true, accepted_gate_codes: [] },
    });
  }

  revalidatePath("/pitches");
  return {
    ok: true,
    approved: (data ?? []).length,
    skipped_no_contact: skippedNoContact,
    skipped_gate: skippedGate,
  };
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
  supabase: Actor["supabase"],
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

export function normalizePains(raw: unknown, companyName?: string | null): Array<GeneratorInputResearchPain & { observed: boolean }> {
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
    // A quote that reads as advice ("Build chatbots for 24/7 inquiry
    // handling") stays usable but is never something seen on their site: the
    // writer may only frame it as a general pattern (claude-composer FACTS 1).
    return [{ pain_id, pain_label, evidence_quote, observed: !isAdviceQuote(evidence_quote, companyName) }];
  });
}

/** Total of several calls' usage (the review loop makes 1–6). */
function sumUsage(usages: ClaudeUsage[]): ClaudeUsage {
  return usages.reduce<ClaudeUsage>(
    (t, u) => ({
      input_tokens: t.input_tokens + u.input_tokens,
      output_tokens: t.output_tokens + u.output_tokens,
      cache_read_input_tokens: t.cache_read_input_tokens + u.cache_read_input_tokens,
      cache_creation_input_tokens: t.cache_creation_input_tokens + u.cache_creation_input_tokens,
      cost_usd: Math.round((t.cost_usd + u.cost_usd) * 1_000_000) / 1_000_000,
    }),
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0 },
  );
}
