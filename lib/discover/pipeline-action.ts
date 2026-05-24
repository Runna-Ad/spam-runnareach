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
        } as never)
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
        } as never)
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
          } as never)
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
      } as never)
      .eq("id", prospectId)
      .eq("tenant_id", user.tenantId);
    revalidatePath("/companies");
    return { prospect_id: prospectId, company_name: name, score: null, outcome: "suppressed" };
  }

  // ── Pass 1: fast enrichment ──────────────────────────────────────────────

  // Step 1: Scrape website — failure is non-fatal
  try {
    await scrapeWebsite(prospectId);
  } catch {
    // Continue — scoring can still run with whatever data exists
  }

  // Step 2: Structured research (pain point extraction) — non-fatal
  try {
    await runStructuredResearch(prospectId);
  } catch {
    // Continue
  }

  // Step 3: Initial score — if this fails entirely, mark as error
  const initialScoreResult = await scoreProspect(prospectId);
  if (!initialScoreResult.ok) {
    return { prospect_id: prospectId, company_name: name, score: null, outcome: "error", error: initialScoreResult.error };
  }
  const initialScore = initialScoreResult.composite_score;

  // Early suppress: not worth running Brave + Claude on a clearly bad prospect
  if (initialScore < 35) {
    await supabase
      .from("prospects")
      .update({
        status: "suppressed",
        suppressed_reason: `Auto: initial score ${initialScore} below threshold`,
        suppressed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", prospectId)
      .eq("tenant_id", user.tenantId);
    revalidatePath("/companies");
    return { prospect_id: prospectId, company_name: name, score: initialScore, outcome: "suppressed" };
  }

  // ── Pass 2: deep research (promising prospects with a URL) ───────────────

  if (hasWebsite) {
    // Step 4: Deep research — Brave intel + Claude synthesis → enriches
    // what_they_do, pain_points, notes. Non-fatal: if it fails (no Brave key,
    // Claude error) we fall through to triage on the initial score.
    try {
      await deepResearchProspect(prospectId);
    } catch {
      // Continue with initial score data
    }

    // Step 5: Second structured research pass — picks up any additional pains
    // that deep research surfaced in what_they_do / notes. Non-fatal.
    try {
      await runStructuredResearch(prospectId);
    } catch {
      // Continue
    }
  }

  // Step 6: Final score on fully enriched data
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
      } as never)
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
      } as never)
      .eq("id", prospectId)
      .eq("tenant_id", user.tenantId);

    revalidatePath("/companies");
    return { prospect_id: prospectId, company_name: name, score, outcome: "needs_review" };
  }

  // Score ≥ 70: generate pitch
  try {
    const pitchResult = await generatePitch(prospectId);
    if (pitchResult.ok) {
      // generatePitch only creates the pitch row (status=draft); we must
      // transition the prospect to 'pitched' here.
      await supabase
        .from("prospects")
        .update({ status: "pitched", pitch_gate_passed: true, updated_at: new Date().toISOString() } as never)
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
    } as never)
    .eq("id", prospectId)
    .eq("tenant_id", user.tenantId);

  revalidatePath("/companies");
  return { prospect_id: prospectId, company_name: name, score, outcome: "needs_review" };
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
