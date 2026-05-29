"use server";

/**
 * Automated prospect pipeline — two-pass.
 *
 * Pass 1 (fast, always runs):
 *   scrapeWebsite → runStructuredResearch → initial scoreProspect
 *   → if initial < 35: suppress immediately (not worth Brave/Claude cost)
 *
 * Pass 2 (deep, only if initial ≥ 35 AND prospect has a URL):
 *   deepResearchProspect (Brave intel + Claude synthesis)
 *   → runStructuredResearch again (second pass on enriched data)
 *   → final scoreProspect
 *
 * Triage on final score:
 *   < 40   → suppressed
 *   40–69  → needs_review (pitch_gate_passed=false)
 *   ≥ 70   → pitched (pitch auto-generated)
 *
 * All steps are wrapped in try/catch so a failure in one step doesn't
 * block the rest of the batch.
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { anymailFindDecisionMaker } from "@/lib/research/anymail-finder";
import { hunterDomainSearch } from "@/lib/research/hunter";
import { snapVerifyEnrich } from "@/lib/research/snap-contact";
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
    }
  }

  // ── Website pitch lane ───────────────────────────────────────────────────
  // Prospects with no web presence can't be scraped or scored meaningfully.
  // If they're ICP-linked (i.e. discovered for a real campaign), we auto-
  // generate a "you need a website" pitch instead of suppressing them.
  // Without an ICP link there's no industry context to personalise — suppress.
  if (!hasWebsite) {
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

  // ── Pass 1: scrape + pain extraction + gate score ───────────────────────
  //
  // Goal: get enough signal to decide if this prospect is worth spending
  // on deep research (Brave + Claude). No SMTP probes yet — save SnapVerify
  // for after deep research so it has the richest possible data to work with.

  // Step 1: Scrape website (homepage + up to 4 sub-pages: About, Team, Contact…)
  try {
    await scrapeWebsite(prospectId);
  } catch {
    // Continue — scoring can still run with whatever data exists
  }

  // Step 2: Structured research — extract pain points from scraped content
  try {
    await runStructuredResearch(prospectId);
  } catch {
    // Continue
  }

  // Step 3: Gate score — suppress clearly bad prospects before spending on Brave/Claude
  const initialScoreResult = await scoreProspect(prospectId);
  if (!initialScoreResult.ok) {
    return { prospect_id: prospectId, company_name: name, score: null, outcome: "error", error: initialScoreResult.error };
  }
  const initialScore = initialScoreResult.composite_score;

  if (initialScore < 35) {
    await supabase
      .from("prospects")
      .update({
        status: "suppressed",
        suppressed_reason: `Auto: initial score ${initialScore} below threshold`,
        suppressed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", prospectId)
      .eq("tenant_id", user.tenantId);
    revalidatePath("/companies");
    return { prospect_id: prospectId, company_name: name, score: initialScore, outcome: "suppressed" };
  }

  // ── Pass 2: deep research + SnapVerify on enriched data ─────────────────
  //
  // SnapVerify runs AFTER deep research so it has Brave intel (founder names,
  // press mentions) in addition to scraped content. This is the correct order:
  // deep research finds "Justine Barber, Co-founder" → SnapVerify guesses
  // justine@poppybarley.com → SMTP probes it → contact found.

  if (hasWebsite) {
    // Step 4: Deep research — Brave people-intel + Claude synthesis → enriches
    // notes with founder names, press mentions, LinkedIn signals.
    try {
      await deepResearchProspect(prospectId);
    } catch {
      // Non-fatal — continue with scraped data
    }

    // Step 5: Second structured research pass — picks up pains surfaced by
    // deep research that weren't visible in the homepage scrape.
    try {
      await runStructuredResearch(prospectId);
    } catch {
      // Continue
    }
  }

  // Step 6: SnapVerify — now runs on the RICHEST available data:
  // homepage + About/Team/Contact sub-pages (2000 chars each) + Brave intel.
  // Free: no API credits. Zero cost on suppressed prospects (they never reach here).
  let snapVerifyFoundContact = false;
  if (p?.domain) {
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
        p.domain,
        research?.notes ?? null,
        research?.what_they_do ?? null,
        p.company_name,
      );

      if (snapResult.found) {
        const priorityRank = snapResult.method === "smtp_verified" ? 1 : 2;
        await supabase.from("prospect_contacts").insert({
          tenant_id: user.tenantId,
          prospect_id: prospectId,
          email: snapResult.email,
          full_name: snapResult.full_name ?? null,
          role_title: snapResult.role_title ?? null,
          email_is_role_based: false,
          priority_rank: priorityRank,
          selected_by:
            snapResult.method === "smtp_verified"
              ? "snapverify_smtp"
              : snapResult.method === "google_workspace_guess"
                ? "snapverify_google_guess"
                : "snapverify_mx_heuristic",
          selected_at: new Date().toISOString(),
        });
        snapVerifyFoundContact = true;
      }
    } catch {
      // Non-fatal — pipeline continues without a contact
    }
  }

  // Step 7: Final score — now reflects contact signal from SnapVerify
  const scoreResult = await scoreProspect(prospectId);
  const score = scoreResult.ok ? scoreResult.composite_score : initialScore;

  // ── Triage on final score ─────────────────────────────────────────────────

  if (score < 40) {
    // Suppress
    await supabase
      .from("prospects")
      .update({
        status: "suppressed",
        suppressed_reason: `Auto: score ${score} below threshold`,
        suppressed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", prospectId)
      .eq("tenant_id", user.tenantId);

    revalidatePath("/companies");
    return { prospect_id: prospectId, company_name: name, score, outcome: "suppressed" };
  }

  if (score < 70) {
    // Needs review — mark pitch_gate_passed=false so badge shows
    await supabase
      .from("prospects")
      .update({
        pitch_gate_passed: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", prospectId)
      .eq("tenant_id", user.tenantId);

    revalidatePath("/companies");
    return { prospect_id: prospectId, company_name: name, score, outcome: "needs_review" };
  }

  // Score ≥ 70: run paid enrichment tiers (Anymail → Hunter).
  // SnapVerify already ran in Step 6 — skip it here to avoid double SMTP probes.
  // Only Anymail + Hunter fire for ≥70 prospects that SnapVerify couldn't resolve.
  if (p?.domain && !snapVerifyFoundContact) {
    try {
      await enrichContactsForProspect(user.tenantId, prospectId, p.domain, p.company_name, supabase, true);
    } catch {
      // Non-fatal — gate check below will catch the no-contact case
    }
  }

  // ── No-contact gate ───────────────────────────────────────────────────────
  // A pitch with no send address is useless. If all three enrichment tiers
  // (SnapVerify → Anymail → Hunter) came up empty, hold the prospect for
  // manual review rather than generating an unsendable pitch.
  type ContactRow = { email: string };
  const { data: validContacts } = await supabase
    .from("prospect_contacts")
    .select("email")
    .eq("prospect_id", prospectId)
    .eq("tenant_id", user.tenantId)
    .not("email", "is", null)
    .limit(1)
    .returns<ContactRow[]>();

  if (!validContacts || validContacts.length === 0) {
    await supabase
      .from("prospects")
      .update({
        pitch_gate_passed: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", prospectId)
      .eq("tenant_id", user.tenantId);
    revalidatePath("/companies");
    return { prospect_id: prospectId, company_name: name, score, outcome: "needs_review" };
  }

  try {
    const pitchResult = await generatePitch(prospectId);
    if (pitchResult.ok) {
      // generatePitch only creates the pitch row (status=draft); we must
      // transition the prospect to 'pitched' here.
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
  } catch {
    // If pitch gen fails, still mark as needs_review rather than error
  }

  // Pitch generation failed — score passed but pitch couldn't be created
  await supabase
    .from("prospects")
    .update({
      pitch_gate_passed: true, // score passed
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

// ── Contact enrichment helper (score-gated, three-tier waterfall) ─────────────

/**
 * Paid contact enrichment for a single prospect (score ≥ 70 only):
 *
 *   When skipSnapVerify=false (default, e.g. re-enrich from UI):
 *     Tier 1 — SnapVerify (free) → Tier 2 — Anymail → Tier 3 — Hunter
 *
 *   When skipSnapVerify=true (pipeline path — SnapVerify already ran in Pass 1):
 *     Tier 2 — Anymail → Tier 3 — Hunter
 *     Skipping SnapVerify avoids redundant SMTP probes on prospects it already
 *     attempted without finding a contact.
 *
 * Short-circuits on first success — each tier preserves the next tier's credits.
 * Duplicate inserts (23505) are silently ignored.
 */
async function enrichContactsForProspect(
  tenantId: string,
  prospectId: string,
  domain: string,
  companyName: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
  skipSnapVerify = false,
): Promise<void> {
  if (!skipSnapVerify) {
    // ── Tier 1: SnapVerify (only when not already run in Pass 1) ─────────────
    type ResearchRow = { notes: string | null; what_they_do: string | null };
    const { data: research } = await supabase
      .from("prospect_research")
      .select("notes, what_they_do")
      .eq("prospect_id", prospectId)
      .eq("tenant_id", tenantId)
      .maybeSingle<ResearchRow>();

    const snapResult = await snapVerifyEnrich(
      prospectId,
      domain,
      research?.notes ?? null,
      research?.what_they_do ?? null,
      companyName,
    );

    if (snapResult.found) {
      const priorityRank = snapResult.method === "smtp_verified" ? 1 : 2;
      await supabase.from("prospect_contacts").insert({
        tenant_id: tenantId,
        prospect_id: prospectId,
        email: snapResult.email,
        full_name: snapResult.full_name ?? null,
        role_title: snapResult.role_title ?? null,
        email_is_role_based: false,
        priority_rank: priorityRank,
        selected_by:
          snapResult.method === "smtp_verified"
            ? "snapverify_smtp"
            : snapResult.method === "google_workspace_guess"
              ? "snapverify_google_guess"
              : "snapverify_mx_heuristic",
        selected_at: new Date().toISOString(),
      });
      // Short-circuit — SnapVerify found a personal email, skip paid tiers
      return;
    }
  }

  // ── Tier 2: Anymail Finder ────────────────────────────────────────────────
  const anymailResult = await anymailFindDecisionMaker(domain);
  if (anymailResult.ok) {
    const c = anymailResult.contact;
    await supabase.from("prospect_contacts").insert({
      tenant_id: tenantId,
      prospect_id: prospectId,
      email: c.email,
      full_name: c.full_name ?? null,
      role_title: c.job_title ?? null,
      linkedin_url: c.linkedin_url ?? null,
      email_is_role_based: false,
      priority_rank: 1,
      selected_by: "anymail",
      selected_at: new Date().toISOString(),
    });
    return; // short-circuit — Anymail found someone, skip Hunter
  }

  // ── Tier 3: Hunter.io ─────────────────────────────────────────────────────
  const hunterResult = await hunterDomainSearch(domain);
  if (hunterResult.ok && hunterResult.contacts.length > 0) {
    for (const contact of hunterResult.contacts) {
      const rank = contact.confidence >= 70 ? 2 : 3;
      await supabase.from("prospect_contacts").insert({
        tenant_id: tenantId,
        prospect_id: prospectId,
        email: contact.email,
        full_name:
          contact.first_name || contact.last_name
            ? [contact.first_name, contact.last_name].filter(Boolean).join(" ")
            : null,
        role_title: contact.position ?? null,
        email_is_role_based: false,
        priority_rank: rank,
        selected_by: "hunter",
        selected_at: new Date().toISOString(),
      });
    }
  }
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
