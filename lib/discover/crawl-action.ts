"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";
import { findDuplicate, normalizeDomain } from "./fuzzy-dedupe";
import { searchBrave, braveIsAvailable } from "./sources/brave-search";
import { searchYellowPagesCA } from "./sources/yellowpages-ca";

// ── Input schema ──────────────────────────────────────────────────────────────

const crawlSchema = z.object({
  source: z.enum(["yellowpages_ca", "brave_search"]),
  keyword: z.string().trim().min(1).max(200),
  /** Province name for YP ("Alberta"), or omit for Brave (uses market) */
  location: z.string().trim().max(200).optional(),
  market: z.enum(["CA", "MX", "US", "LATAM"]).default("CA"),
  /** How many YP pages to scrape (1-10). Brave always fetches 20 results. */
  pages: z.number().int().min(1).max(10).default(3),
  icp_id: z.string().uuid().nullable().optional(),
});

export type CrawlInput = z.input<typeof crawlSchema>;

export type CrawlResult =
  | {
      ok: true;
      run_id: string;
      source: "yellowpages_ca" | "brave_search";
      candidates_found: number;
      candidates_new: number;
      candidates_duplicate: number;
      red_flags: number;
    }
  | { ok: false; error: string };

// ── Main action ───────────────────────────────────────────────────────────────

export async function runCrawl(input: CrawlInput): Promise<CrawlResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot run discovery crawls." };
  }

  const parsed = crawlSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const { source, keyword, location, market, pages, icp_id } = parsed.data;
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  // ── Open discovery_run row ──────────────────────────────────────────────
  const { data: runRow, error: runErr } = await supabase
    .from("discovery_runs")
    .insert({
      tenant_id: user.tenantId,
      icp_id: icp_id ?? null,
      source,
      triggered_by: user.id,
      status: "running",
      started_at: nowIso,
    })
    .select("id")
    .single<{ id: string }>();

  if (runErr || !runRow) {
    return {
      ok: false,
      error: `Could not start crawl run: ${runErr?.message ?? "no row"}`,
    };
  }

  // ── Fetch raw listings from source ──────────────────────────────────────
  const rawListings = await fetchFromSource({
    source,
    keyword,
    location,
    market,
    pages,
  });

  if (!rawListings.ok) {
    await failRun(runRow.id, rawListings.error);
    return { ok: false, error: rawListings.error };
  }

  // ── Load existing prospects for dedupe ──────────────────────────────────
  const { data: existing, error: existingErr } = await supabase
    .from("prospects")
    .select("company_name, domain")
    .eq("tenant_id", user.tenantId)
    .returns<{ company_name: string; domain: string | null }[]>();

  if (existingErr) {
    await failRun(runRow.id, `Could not preload prospects: ${existingErr.message}`);
    return { ok: false, error: `Could not preload prospects: ${existingErr.message}` };
  }

  const seen: { name: string; domain: string | null }[] = (existing ?? []).map((e) => ({
    name: e.company_name,
    domain: e.domain,
  }));

  // ── Dedupe + build inserts ──────────────────────────────────────────────
  let candidates_new = 0;
  let candidates_duplicate = 0;
  let red_flags = 0;
  const inserts: Database["public"]["Tables"]["prospects"]["Insert"][] = [];

  for (const listing of rawListings.listings) {
    const normalizedDomain = listing.domain
      ? normalizeDomain(listing.domain)
      : null;

    const dup = findDuplicate(
      { name: listing.company_name, domain: normalizedDomain },
      seen,
    );
    if (dup !== -1) {
      candidates_duplicate++;
      continue;
    }

    seen.push({ name: listing.company_name, domain: normalizedDomain });
    candidates_new++;

    const flags: string[] = [];
    if (!normalizedDomain) flags.push("missing_domain");
    red_flags += flags.length;

    inserts.push({
      tenant_id: user.tenantId,
      icp_id: icp_id ?? null,
      discovery_run_id: runRow.id,
      discovery_source: source,
      company_name: listing.company_name,
      domain: normalizedDomain,
      website_url: listing.website_url ?? null,
      industry: keyword, // keyword becomes the industry label
      city: listing.city ?? null,
      region: listing.region ?? null,
      country_code: marketToCountry(market),
      market,
      language: market === "MX" ? "es" : "en",
      status: "raw",
      red_flags: flags,
    });
  }

  // ── Bulk insert ─────────────────────────────────────────────────────────
  if (inserts.length > 0) {
    const { error: insertErr } = await supabase.from("prospects").insert(inserts);
    if (insertErr) {
      await failRun(runRow.id, `Insert failed: ${insertErr.message}`);
      return { ok: false, error: `Could not save prospects: ${insertErr.message}` };
    }
  }

  // ── Close run ───────────────────────────────────────────────────────────
  await supabase
    .from("discovery_runs")
    .update({
      status: "complete",
      candidates_found: rawListings.listings.length,
      candidates_new,
      candidates_duplicate,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runRow.id);

  await writeAuditLog({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "prospect.scored", // closest existing; future: discovery.run_completed
    entityType: "prospect",
    entityId: runRow.id,
    metadata: {
      kind: "crawl",
      source,
      keyword,
      location: location ?? null,
      market,
      candidates_found: rawListings.listings.length,
      candidates_new,
      candidates_duplicate,
    },
  });

  revalidatePath("/discover");
  revalidatePath("/companies");

  return {
    ok: true,
    run_id: runRow.id,
    source,
    candidates_found: rawListings.listings.length,
    candidates_new,
    candidates_duplicate,
    red_flags,
  };
}

// ── Source dispatcher ─────────────────────────────────────────────────────────

type NormalizedListing = {
  company_name: string;
  website_url: string | null;
  domain: string | null;
  city: string | null;
  region: string | null; // province code for CA, state for US/MX
};

type FetchSourceResult =
  | { ok: true; listings: NormalizedListing[] }
  | { ok: false; error: string };

async function fetchFromSource(opts: {
  source: "yellowpages_ca" | "brave_search";
  keyword: string;
  location: string | undefined;
  market: "CA" | "MX" | "US" | "LATAM";
  pages: number;
}): Promise<FetchSourceResult> {
  if (opts.source === "yellowpages_ca") {
    const loc = opts.location ?? "Canada";
    const result = await searchYellowPagesCA({
      keyword: opts.keyword,
      location: loc,
      pages: opts.pages,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      listings: result.listings.map((l) => ({
        company_name: l.company_name,
        website_url: l.website_url,
        domain: l.domain,
        city: l.city,
        region: l.province_code,
      })),
    };
  }

  if (opts.source === "brave_search") {
    if (!braveIsAvailable()) {
      return {
        ok: false,
        error: "Brave Search not configured — add BRAVE_SEARCH_API_KEY to .env.local",
      };
    }
    const country =
      opts.market === "CA" ? "CA"
      : opts.market === "MX" ? "MX"
      : opts.market === "US" ? "US"
      : "CA";

    const result = await searchBrave({
      query: opts.keyword,
      country,
      count: 20,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      listings: result.listings.map((l) => ({
        company_name: l.company_name,
        website_url: l.website_url,
        domain: l.domain,
        city: null,
        region: null,
      })),
    };
  }

  return { ok: false, error: `Unknown source: ${opts.source}` };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function failRun(runId: string, msg: string) {
  const supabase = await createClient();
  await supabase
    .from("discovery_runs")
    .update({
      status: "failed",
      error_message: msg.slice(0, 500),
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

function marketToCountry(market: "CA" | "MX" | "US" | "LATAM"): string {
  switch (market) {
    case "CA": return "CA";
    case "MX": return "MX";
    case "US": return "US";
    case "LATAM": return "MX";
  }
}
