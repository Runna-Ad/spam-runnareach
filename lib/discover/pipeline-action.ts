"use server";

/**
 * Automated prospect pipeline.
 *
 * Pass 1 — structural gate (cheap, always runs):
 *   scrapeWebsite (homepage + 4 sub-pages) → scoreProspect on structural signals
 *   → if score < 10: suppress (sanity check — clearly wrong fit, e.g. wrong country)
 *
 * Pass 2 — full enrichment (only if structural score ≥ 20):
 *   deepResearchProspect (Brave people-intel + Claude synthesis)
 *   → snapVerifyEnrich (founder names from deep research → SMTP probe)
 *   → runStructuredResearch (pain extraction on ALL data: scrape + Brave)
 *   → final scoreProspect (pain signal + contact signal both present)
 *
 * Triage on final score:
 *   < 40   → suppressed
 *   40–69  → needs_review
 *   ≥ 70   → Anymail/Hunter → pitch auto-generated
 *
 * All steps are try/catch — one failure never blocks the rest of the batch.
 */

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { snapVerifyEnrich } from "@/lib/research/snap-contact";
import { isRoleBasedEmail } from "@/lib/research/email-utils";
import { enrichContactsForProspect } from "@/lib/discover/enrich-contacts";
import { scrapeWebsite } from "@/lib/research/scrape-action";
import { runStructuredResearch } from "@/lib/research/structured-research-action";
import { deepResearchProspect } from "@/lib/research/deep-research-action";
import { scoreProspect } from "@/lib/research/score-action";
import { generatePitch } from "@/lib/pitches/actions";
import { generateWebsitePitch } from "@/lib/pitches/website-pitch-action";
import { searchBrave, braveIsAvailable } from "@/lib/discover/sources/brave-search";
import { normalizeDomain } from "@/lib/discover/fuzzy-dedupe";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProspectOutcome = "suppressed" | "needs_review" | "pitched" | "website_pitch" | "error";

export type SinglePipelineResult = {
  prospect_id: string;
  company_name: string;
  score: number | null;
  outcome: ProspectOutcome;
  error?: string;
};

export type PipelineSummary = {
  ok: true;
  total: number;
  pitched: number;
  needs_review: number;
  suppressed: number;
  errors: number;
  results: SinglePipelineResult[];
};

// ── Public: get new prospect IDs from a set of runs ──────────────────────────

export async function getProspectIdsForRuns(
  runIds: string[],
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  if (runIds.length === 0) return { ok: true, ids: [] };

  const user = await requireUser();
  const supabase = await createClient();

  type Row = { id: string };
  const { data, error } = await supabase
    .from("prospects")
    .select("id")
    .eq("tenant_id", user.tenantId)
    .eq("status", "raw")
    .in("discovery_run_id", runIds)
    .returns<Row[]>();

  if (error) return { ok: false, error: error.message };
  return { ok: true, ids: (data ?? []).map((r) => r.id) };
}

// ── Public: get ALL raw prospect IDs for an ICP (or entire tenant) ────────────
// Used as a fallback when the discovery run timed out and we still need to
// process prospects that were inserted before the 504 hit.

export async function getRawProspectIds(
  icpId?: string,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const user = await requireUser();
  const supabase = await createClient();

  type Row = { id: string };
  let query = supabase
    .from("prospects")
    .select("id")
    .eq("tenant_id", user.tenantId)
    .eq("status", "raw");

  if (icpId) {
    query = query.eq("icp_id", icpId);
  }

  const { data, error } = await query
    .order("created_at", { ascending: true })
    .limit(50)
    .returns<Row[]>();

  if (error) return { ok: false, error: error.message };
  return { ok: true, ids: (data ?? []).map((r) => r.id) };
}

// ── Public: count raw prospects (for UI badges) ────────────────────────────────

export async function countRawProspects(
  icpId?: string,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const user = await requireUser();
  const supabase = await createClient();

  let query = supabase
    .from("prospects")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", user.tenantId)
    .eq("status", "raw");

  if (icpId) {
    query = query.eq("icp_id", icpId);
  }

  const { count, error } = await query;

  if (error) return { ok: false, error: error.message };
  return { ok: true, count: count ?? 0 };
}

// ── Public: discard unprocessed raw prospects ─────────────────────────────────
// After a discovery run is stopped (or finished with leftovers), the user may not
// want to keep the inserted-but-unprocessed prospects. This deletes the raw ones
// for an ICP (only status='raw' — never touches already-pipelined prospects).

export async function discardRawProspects(
  icpId?: string,
): Promise<{ ok: true; deleted: number } | { ok: false; error: string }> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot delete prospects." };

  const supabase = await createClient();

  let query = supabase
    .from("prospects")
    .delete()
    .eq("tenant_id", user.tenantId)
    .eq("status", "raw");

  if (icpId) {
    query = query.eq("icp_id", icpId);
  }

  const { data, error } = await query.select("id");
  if (error) return { ok: false, error: error.message };

  revalidatePath("/companies");
  revalidatePath("/discover");
  return { ok: true, deleted: (data ?? []).length };
}

// ── Public: process one prospect through the full pipeline ───────────────────

export async function processSingleProspect(
  prospectId: string,
): Promise<SinglePipelineResult> {
  const user = await requireUser();
  const supabase = await createClient();

  // Load prospect info — include domain/website_url so we can detect no-website early
  type ProspectRow = {
    id: string;
    company_name: string;
    status: string;
    domain: string | null;
    website_url: string | null;
    icp_id: string | null;
    city: string | null;
    country_code: string | null;
  };
  const { data: p } = await supabase
    .from("prospects")
    .select("id, company_name, status, domain, website_url, icp_id, city, country_code")
    .eq("id", prospectId)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<ProspectRow>();

  const name = p?.company_name ?? prospectId;
  let hasWebsite = !!(p?.domain || p?.website_url);
  const hasIcp = !!(p?.icp_id);
  // The domain later steps should use. `p` is a snapshot from before website
  // discovery — using p.domain after a successful discovery silently skipped
  // SnapVerify + the enrichment waterfall, so every discovered-website
  // prospect ended up "no contact found" and was suppressed after full spend.
  let effectiveDomain = p?.domain ?? null;

  // ── Website discovery via Brave (for no-website prospects like Yelp results) ─
  // Yelp and other directory sources don't include website URLs in their search
  // results. Before routing to the website-pitch lane, try to find the business's
  // actual website via a targeted Brave search. If found, the prospect goes
  // through the normal scrape → research → score pipeline instead.
  if (!hasWebsite && braveIsAvailable() && p?.company_name) {
    const discovered = await discoverWebsiteViaBrave(
      p.company_name,
      p.city,
      p.country_code === "MX" ? "MX" : p.country_code === "US" ? "US" : "CA",
    );
    if (discovered) {
      // Also remove "missing_domain" from red_flags now that we have a site
      const { data: cur } = await supabase
        .from("prospects")
        .select("red_flags")
        .eq("id", prospectId)
        .eq("tenant_id", user.tenantId)
        .maybeSingle<{ red_flags: string[] }>();
      const cleanFlags = (cur?.red_flags ?? []).filter((f) => f !== "missing_domain");

      await supabase
        .from("prospects")
        .update({
          website_url: discovered.website_url,
          domain: discovered.domain,
          red_flags: cleanFlags,
          updated_at: new Date().toISOString(),
        })
        .eq("id", prospectId)
        .eq("tenant_id", user.tenantId);
      hasWebsite = true;
      effectiveDomain = discovered.domain;
    }
  }

  // ── Website pitch lane ───────────────────────────────────────────────────
  // Prospects with no web presence can't be scraped or scored meaningfully.
  // If they're ICP-linked (i.e. discovered for a real campaign), we auto-
  // generate a "you need a website" pitch instead of suppressing them.
  // Without an ICP link there's no industry context to personalise — suppress.
  // Also entered mid-pipeline when the stored domain turns out not to exist
  // (DNS-dead): the domain is cleared first, then the prospect lands here.
  async function runNoWebsiteLane(): Promise<SinglePipelineResult> {
    if (!hasIcp) {
      await supabase
        .from("prospects")
        .update({
          status: "suppressed",
          suppressed_reason: "Auto: no website and no ICP context",
          suppressed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", prospectId)
        .eq("tenant_id", user.tenantId);
      revalidatePath("/companies");
      return { prospect_id: prospectId, company_name: name, score: null, outcome: "suppressed" };
    }

    // Has ICP → generate website pitch
    try {
      const pitchResult = await generateWebsitePitch(prospectId);
      if (pitchResult.ok) {
        await supabase
          .from("prospects")
          .update({
            status: "pitched",
            pitch_gate_passed: true,
            updated_at: new Date().toISOString(),
          })
          .eq("id", prospectId)
          .eq("tenant_id", user.tenantId);
        revalidatePath("/companies");
        revalidatePath("/funnel");
        revalidatePath("/pitches");
        return { prospect_id: prospectId, company_name: name, score: null, outcome: "website_pitch" };
      }
    } catch {
      // fall through to normal suppress if pitch gen explodes
    }
    // Website pitch failed — suppress rather than leave in raw
    await supabase
      .from("prospects")
      .update({
        status: "suppressed",
        suppressed_reason: "Auto: no website, pitch generation failed",
        suppressed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", prospectId)
      .eq("tenant_id", user.tenantId);
    revalidatePath("/companies");
    return { prospect_id: prospectId, company_name: name, score: null, outcome: "suppressed" };
  }

  if (!hasWebsite) {
    return runNoWebsiteLane();
  }

  // ── Pass 1: scrape + gate score (no pain extraction yet) ───────────────
  //
  // Gate on cheap signals only: industry fit, geo, tech stack, size.
  // Pain extraction runs AFTER deep research so it has maximum data to
  // work with. Gate threshold is 20 (not 35) because pain_signal_pts
  // (max 15) aren't present yet — we're gating on structural fit only.

  // Step 1: Scrape website (homepage + up to 4 sub-pages: About, Team, Contact…)
  try {
    const scrapeResult = await scrapeWebsite(prospectId);
    if (!scrapeResult.ok && scrapeResult.domain_dead) {
      // The stored domain has no DNS records — it either lapsed or was never
      // theirs (auto-discovery can attach a wrong domain). Clear it and pitch
      // the honest "no website" angle. NEVER email a prospect claiming a
      // domain we can't verify is theirs is "their broken site".
      const { data: cur } = await supabase
        .from("prospects")
        .select("red_flags")
        .eq("id", prospectId)
        .eq("tenant_id", user.tenantId)
        .maybeSingle<{ red_flags: string[] }>();
      const flags = new Set(cur?.red_flags ?? []);
      flags.add("dead_domain");
      await supabase
        .from("prospects")
        .update({
          website_url: null,
          domain: null,
          red_flags: Array.from(flags),
          updated_at: new Date().toISOString(),
        })
        .eq("id", prospectId)
        .eq("tenant_id", user.tenantId);
      hasWebsite = false;
      return runNoWebsiteLane();
    }
  } catch {
    // Continue — scoring can still run with whatever data exists
  }

  // Step 2: Gate score — structural fit only (industry, geo, tech, size).
  // No pain points yet — those come after deep research.
  const initialScoreResult = await scoreProspect(prospectId);
  if (!initialScoreResult.ok) {
    return { prospect_id: prospectId, company_name: name, score: null, outcome: "error", error: initialScoreResult.error };
  }
  const initialScore = initialScoreResult.composite_score;

  // Sanity-check only — threshold is 10. Only suppresses structurally-wrong
  // prospects (wrong country, completely off-industry). Everything else gets
  // full deep research. At $0.023/prospect deep research is cheap enough that
  // we'd rather over-research than under-research.
  if (initialScore < 10) {
    await supabase
      .from("prospects")
      .update({
        status: "suppressed",
        suppressed_reason: `Auto: structural score ${initialScore} — clearly wrong fit (industry/geo/size)`,
        suppressed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", prospectId)
      .eq("tenant_id", user.tenantId);
    revalidatePath("/companies");
    return { prospect_id: prospectId, company_name: name, score: initialScore, outcome: "suppressed" };
  }

  // ── Pass 2: deep research → SnapVerify → pain extraction → final score ──
  //
  // Everything runs on the richest possible data. Order matters:
  // deep research first (Brave people-intel → founder names in notes)
  // → SnapVerify (uses those names to guess + probe emails)
  // → pain extraction (uses all data: scrape + Brave + sub-pages)
  // → final score (has both pain signal AND contact signal)

  if (hasWebsite) {
    // Step 3: Deep research — Brave people-intel + Claude synthesis.
    // Enriches notes with founder names, press mentions, LinkedIn signals.
    // skipScore: the pipeline re-scores at Step 6 on the fully-enriched data
    // (after pain extraction), so deep research's internal re-score would be
    // computed then immediately overwritten — one wasted Haiku call/prospect.
    try {
      await deepResearchProspect(prospectId, { skipScore: true });
    } catch {
      // Non-fatal — continue with scraped data
    }
  }

  // Step 4: SnapVerify — runs on RICHEST available data:
  // homepage + About/Team/Contact sub-pages (2000 chars each) + Brave intel.
  // Free: no API credits. Suppressed prospects never reach here.
  let snapVerifyFoundContact = false;
  if (effectiveDomain) {
    try {
      type ResearchRow = { notes: string | null; what_they_do: string | null };
      const { data: research } = await supabase
        .from("prospect_research")
        .select("notes, what_they_do")
        .eq("prospect_id", prospectId)
        .eq("tenant_id", user.tenantId)
        .maybeSingle<ResearchRow>();

      const snapResult = await snapVerifyEnrich(
        prospectId,
        effectiveDomain,
        research?.notes ?? null,
        research?.what_they_do ?? null,
        p?.company_name ?? name,
      );

      if (snapResult.found) {
        // SMTP-verified personal email (the only thing SnapVerify "finds" now).
        await supabase.from("prospect_contacts").insert({
          tenant_id: user.tenantId,
          prospect_id: prospectId,
          email: snapResult.email,
          full_name: snapResult.full_name ?? null,
          role_title: snapResult.role_title ?? null,
          email_is_role_based: isRoleBasedEmail(snapResult.email),
          priority_rank: isRoleBasedEmail(snapResult.email) ? 5 : 1,
          selected_by: "snapverify_smtp",
          selected_at: new Date().toISOString(),
        });
        snapVerifyFoundContact = true;
      }
    } catch {
      // Non-fatal — pipeline continues without a contact
    }
  }

  // Step 5: Pain extraction — runs ONCE on ALL available data:
  // scrape (homepage + sub-pages) + deep research (Brave intel) combined.
  // This produces the highest-quality pain points with real evidence quotes.
  try {
    await runStructuredResearch(prospectId);
  } catch {
    // Non-fatal — continue without pain points
  }

  // Step 6: Final score — has pain signal + contact signal + all research.
  // If it fails, STOP — do not triage (and possibly pitch) on the Pass-1
  // structural score, which never saw pain evidence and can clear 70 on
  // structure alone. The prospect stays researched for a re-run.
  const scoreResult = await scoreProspect(prospectId);
  if (!scoreResult.ok) {
    return {
      prospect_id: prospectId,
      company_name: name,
      score: initialScore,
      outcome: "error",
      error: `Final score failed: ${scoreResult.error}`,
    };
  }
  const score = scoreResult.composite_score;

  // ── Triage on final score ─────────────────────────────────────────────────

  if (score < 50) {
    // Below the floor — suppress.
    await supabase
      .from("prospects")
      .update({
        status: "suppressed",
        suppressed_reason: `Auto: score ${score} below 50`,
        suppressed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", prospectId)
      .eq("tenant_id", user.tenantId);

    revalidatePath("/companies");
    return { prospect_id: prospectId, company_name: name, score, outcome: "suppressed" };
  }

  if (score < 70) {
    // 50-69 → B-list: a time-boxed, opt-in review pool (out of the default view,
    // auto-suppressed after 21 days untouched by the janitor). updated_at below
    // anchors that clock.
    await supabase
      .from("prospects")
      .update({
        status: "b_list",
        suppressed_reason: null,
        suppressed_at: null,
        pitch_gate_passed: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", prospectId)
      .eq("tenant_id", user.tenantId);

    revalidatePath("/companies");
    return { prospect_id: prospectId, company_name: name, score, outcome: "needs_review" };
  }

  // Score ≥ 70 with no verified contact yet: run the full waterfall
  // (SnapVerify 3-pass → Anymail → Hunter → catch-all-safe guess). We pass
  // skipSnapVerify=false so SnapVerify re-runs here and can surface the
  // catch-all best-guess as a last resort — Pass-1's run only inserts verified.
  if (effectiveDomain && !snapVerifyFoundContact) {
    try {
      await enrichContactsForProspect(user.tenantId, prospectId, effectiveDomain, p?.company_name ?? name, supabase, false);
    } catch (err) {
      console.error(`[pipeline] enrichContactsForProspect failed for ${name}:`, err);
    }
  } else {
    console.log(`[pipeline] skipping enrichContacts for ${name}: domain=${effectiveDomain} snapVerifyFound=${snapVerifyFoundContact}`);
  }

  // ── No-contact gate ───────────────────────────────────────────────────────
  type ContactRow = { email: string };
  const { data: validContacts, error: contactGateErr } = await supabase
    .from("prospect_contacts")
    .select("email")
    .eq("prospect_id", prospectId)
    .eq("tenant_id", user.tenantId)
    .not("email", "is", null)
    .limit(1)
    .returns<ContactRow[]>();

  // Write contact gate result to audit_log so we can diagnose from DB
  await writeAuditLog({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "prospect.scored",
    entityType: "prospect",
    entityId: prospectId,
    metadata: {
      kind: "contact_gate",
      contacts_found: validContacts?.length ?? 0,
      gate_error: contactGateErr?.message ?? null,
      score,
    },
  });

  if (!validContacts || validContacts.length === 0) {
    // ≥70 but unreachable: we ran the full enrichment waterfall and still found no
    // email — "if we didn't get it in the pipeline, we aren't getting it" — so
    // suppress rather than park it in a worklist nobody clears.
    await supabase
      .from("prospects")
      .update({
        status: "suppressed",
        suppressed_reason: `Auto: score ${score} but no contact found (unreachable)`,
        suppressed_at: new Date().toISOString(),
        pitch_gate_passed: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", prospectId)
      .eq("tenant_id", user.tenantId);
    revalidatePath("/companies");
    return { prospect_id: prospectId, company_name: name, score, outcome: "suppressed" };
  }

  let pitchError: string | null = null;
  try {
    // Pass user + supabase to avoid a second requireUser() call inside
    // generatePitch — cookies() can be restricted in nested server action
    // contexts, causing silent redirect failures.
    const pitchResult = await generatePitch(prospectId, { user, supabase });
    if (pitchResult.ok) {
      await supabase
        .from("prospects")
        .update({ status: "pitched", pitch_gate_passed: true, updated_at: new Date().toISOString() })
        .eq("id", prospectId)
        .eq("tenant_id", user.tenantId);

      revalidatePath("/companies");
      revalidatePath("/funnel");
      revalidatePath("/pitches");
      return { prospect_id: prospectId, company_name: name, score, outcome: "pitched" };
    }
    pitchError = pitchResult.error;
  } catch (err) {
    pitchError = err instanceof Error ? err.message : String(err);
  }

  // Log pitch failure to audit_log so we can diagnose it
  if (pitchError) {
    console.error(`[pipeline] generatePitch failed for ${name} (${prospectId}): ${pitchError}`);
    await writeAuditLog({
      tenantId: user.tenantId,
      actorId: user.id,
      action: "prospect.scored",
      entityType: "prospect",
      entityId: prospectId,
      metadata: { kind: "pitch_generation_failed", error: pitchError, score },
    });
  }

  // Score passed but pitch couldn't be created — mark gate passed so UI shows
  // correct state, and reactivate if the prospect was parked.
  const reactivate = p?.status === "suppressed" || p?.status === "no_match";
  await supabase
    .from("prospects")
    .update({
      ...(reactivate
        ? { status: "researched", suppressed_reason: null, suppressed_at: null }
        : {}),
      pitch_gate_passed: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", prospectId)
    .eq("tenant_id", user.tenantId);

  revalidatePath("/companies");
  return { prospect_id: prospectId, company_name: name, score, outcome: "needs_review" };
}

// ── Public: re-enrich contacts for an existing prospect ──────────────────────
// Called from the prospect detail page when a prospect already passed through
// the pipeline but ended up with no contact email (all three tiers missed).
// Works on any status — doesn't require the prospect to be raw.

export async function reEnrichProspectContacts(
  prospectId: string,
): Promise<
  | { ok: true; found: boolean; email?: string; method?: string }
  | { ok: false; error: string }
> {
  const user = await requireUser();
  const supabase = await createClient();

  type ProspectRow = { domain: string | null; company_name: string };
  const { data: p } = await supabase
    .from("prospects")
    .select("domain, company_name")
    .eq("id", prospectId)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<ProspectRow>();

  if (!p?.domain) {
    return { ok: false, error: "Prospect has no domain — can't enrich contacts" };
  }

  try {
    await enrichContactsForProspect(user.tenantId, prospectId, p.domain, p.company_name, supabase);
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? "Enrichment failed" };
  }

  // Report what was found (if anything)
  type ContactRow = { email: string; selected_by: string };
  const { data: contacts } = await supabase
    .from("prospect_contacts")
    .select("email, selected_by")
    .eq("prospect_id", prospectId)
    .eq("tenant_id", user.tenantId)
    .not("email", "is", null)
    .order("priority_rank", { ascending: true })
    .limit(1)
    .returns<ContactRow[]>();

  const best = contacts?.[0];
  if (best) {
    return { ok: true, found: true, email: best.email, method: best.selected_by };
  }
  return { ok: true, found: false };
}

// ── Prune run to top 30 ────────────────────────────────────────────────────────

/**
 * After the pipeline processes a batch of prospects, keep only the top 30
 * by score and hard-delete the rest. Called from the RunAllModal after the
 * pipeline loop completes.
 *
 * Sort order:
 *   1. Pitched prospects always survive (score ≥70, pitch already generated)
 *   2. Remaining sorted by match_score DESC (null last)
 *
 * If ≤30 prospects were processed, nothing is deleted.
 */
export async function pruneRunToTop30(
  prospectIds: string[],
): Promise<{ ok: true; kept: number; deleted: number } | { ok: false; error: string }> {
  if (prospectIds.length <= 30) return { ok: true, kept: prospectIds.length, deleted: 0 };

  const user = await requireUser();
  const supabase = await createClient();

  type Row = { id: string; match_score: number | null; status: string };
  const { data, error } = await supabase
    .from("prospects")
    .select("id, match_score, status")
    .eq("tenant_id", user.tenantId)
    .in("id", prospectIds)
    .returns<Row[]>();

  if (error) return { ok: false, error: error.message };

  const all = data ?? [];
  if (all.length <= 30) return { ok: true, kept: all.length, deleted: 0 };

  // Sort: pitched first (must survive), then by score descending, nulls last
  all.sort((a, b) => {
    if (a.status === "pitched" && b.status !== "pitched") return -1;
    if (b.status === "pitched" && a.status !== "pitched") return 1;
    return (b.match_score ?? -1) - (a.match_score ?? -1);
  });

  const toDelete = all.slice(30).map((p) => p.id);

  const { error: delErr } = await supabase
    .from("prospects")
    .delete()
    .in("id", toDelete)
    .eq("tenant_id", user.tenantId);

  if (delErr) return { ok: false, error: delErr.message };

  revalidatePath("/companies");
  revalidatePath("/discover");
  return { ok: true, kept: Math.min(all.length, 30), deleted: toDelete.length };
}

// ── Website discovery helper ───────────────────────────────────────────────────

/**
 * Tries to find a business's actual website via Brave Search.
 * Used for prospects discovered from sources that don't return website URLs
 * (primarily Yelp). Returns null if nothing useful is found.
 *
 * Uses 1 Brave API call per prospect. Quota: 2,000 free/month.
 */
async function discoverWebsiteViaBrave(
  companyName: string,
  city: string | null,
  country: "CA" | "MX" | "US",
): Promise<{ website_url: string; domain: string } | null> {
  // Directories/social networks — skip these as the "website"
  const SKIP_DOMAINS = [
    "yelp.com", "yelp.ca", "yelp.com.mx",
    "facebook.com", "fb.com", "instagram.com", "twitter.com", "x.com", "tiktok.com",
    "linkedin.com", "pinterest.com", "snapchat.com",
    "yellowpages.ca", "yellowpages.com", "pagesjaunes.ca",
    "tripadvisor.com", "tripadvisor.ca", "tripadvisor.com.mx",
    "google.com", "bing.com", "maps.apple.com",
    "foursquare.com", "zomato.com", "opentable.com",
    "bbb.org", "canadabusiness.ca", "canada411.ca",
  ];

  const locationHint = city ? ` ${city}` : "";
  const query = `"${companyName}"${locationHint} official website`;

  try {
    const result = await searchBrave({ query, country, count: 5 });
    if (!result.ok) return null;

    for (const listing of result.listings) {
      if (!listing.website_url || !listing.domain) continue;
      if (SKIP_DOMAINS.some((skip) => listing.domain!.includes(skip))) continue;
      // Must look like a real domain (has a dot, not just a path)
      if (!listing.domain.includes(".")) continue;
      // The site must plausibly BELONG to this company — a generic search
      // result is not their website. Require a significant company-name token
      // in the domain or the result title. (We once attached a stranger's — and
      // nonexistent — domain to a prospect and emailed them about "their" site.)
      if (!nameMatchesListing(companyName, listing.domain, listing.company_name)) continue;
      // And the domain must actually be live — Brave's index can hold dead
      // domains. Any HTTP response (even 403 bot-blocking) proves it exists;
      // DNS/connection failure means it doesn't.
      if (!(await domainIsLive(listing.website_url))) continue;
      return {
        website_url: listing.website_url,
        domain: normalizeDomain(listing.website_url) ?? listing.domain,
      };
    }
  } catch {
    // Non-fatal — fall through to website pitch lane
  }

  return null;
}

/**
 * True when at least one significant token of the company name (≥4 chars,
 * not a generic filler word) appears in the candidate DOMAIN. The domain is
 * the only signal that actually identifies the site's owner — a result TITLE
 * can mention the company on someone else's site (directory profile pages),
 * which is how a stranger's domain got attached to a prospect.
 */
function nameMatchesListing(companyName: string, domain: string, _title: string): boolean {
  const GENERIC = new Set([
    "the", "and", "les", "las", "los", "del", "de", "inc", "ltd", "llc",
    "corp", "shop", "store", "tienda", "casa", "grupo", "group", "company",
    "studio", "salon", "centro", "center", "clinic", "clinica",
  ]);
  const tokens = companyName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !GENERIC.has(t));
  if (tokens.length === 0) return false;
  const haystack = domain
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return tokens.some((t) => haystack.includes(t));
}

/**
 * Quick liveness probe. Any HTTP response (even 403 bot-blocking) proves the
 * domain exists. Only a definitive DNS "no such domain" (ENOTFOUND) counts as
 * dead — timeouts, TLS quirks, and connection resets happen on real sites, and
 * the name-match check above remains the primary guard.
 */
async function domainIsLive(url: string): Promise<boolean> {
  try {
    await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(5_000),
    });
    return true;
  } catch (err) {
    const causeCode =
      err instanceof Error && err.cause && typeof err.cause === "object" && "code" in err.cause
        ? String((err.cause as { code?: unknown }).code)
        : null;
    return causeCode !== "ENOTFOUND";
  }
}
