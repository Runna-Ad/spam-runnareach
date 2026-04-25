"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { findDuplicate, normalizeDomain } from "./fuzzy-dedupe";

const marketEnum = z.enum(["CA", "MX", "US", "LATAM"]);
const languageEnum = z.enum(["en", "es"]);

const rowSchema = z.object({
  company_name: z.string().trim().min(1).max(200),
  domain: z.string().trim().max(200).nullable(),
  website_url: z.string().trim().max(500).nullable(),
  industry: z.string().trim().max(120).nullable(),
  city: z.string().trim().max(120).nullable(),
  region: z.string().trim().max(120).nullable(),
  market: marketEnum,
  language: languageEnum.optional(),
});

const uploadSchema = z.object({
  icp_id: z.string().uuid().nullable(),
  rows: z.array(rowSchema).min(1).max(500),
});

export type UploadProspectsInput = z.input<typeof uploadSchema>;

export type UploadProspectsResult =
  | {
      ok: true;
      run_id: string;
      candidates_found: number;
      candidates_new: number;
      candidates_duplicate: number;
      red_flags: number;
    }
  | { ok: false; error: string };

/**
 * Manual CSV upload path. Creates a `discovery_runs` row + bulk-inserts
 * `prospects`. Dedupes against existing prospects in the same tenant on
 * normalized domain. Rows without domain dedupe by name similarity.
 */
export async function uploadProspects(
  input: UploadProspectsInput,
): Promise<UploadProspectsResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot upload prospects." };

  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  // Open the discovery_runs row first so we can attach prospects to it.
  const { data: runRow, error: runErr } = await supabase
    .from("discovery_runs")
    .insert({
      tenant_id: user.tenantId,
      icp_id: parsed.data.icp_id,
      source: "manual_upload",
      triggered_by: user.id,
      status: "running",
      started_at: nowIso,
    } as never)
    .select("id")
    .single<{ id: string }>();

  if (runErr || !runRow) {
    return { ok: false, error: `Could not start upload run: ${runErr?.message ?? "no row"}` };
  }

  // Normalize + load the existing prospect set for client-side dedupe.
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

  let candidates_new = 0;
  let candidates_duplicate = 0;
  let red_flags_count = 0;
  const inserts: Record<string, unknown>[] = [];

  for (const row of parsed.data.rows) {
    const normalizedDomain = row.domain ? normalizeDomain(row.domain) : null;

    const dup = findDuplicate(
      { name: row.company_name, domain: normalizedDomain },
      seen,
    );
    if (dup !== -1) {
      candidates_duplicate++;
      continue;
    }

    seen.push({ name: row.company_name, domain: normalizedDomain });
    candidates_new++;

    const flags: string[] = [];
    if (!normalizedDomain) flags.push("missing_domain");
    if (red_flags_count + flags.length > 0 && flags.length > 0) {
      red_flags_count += flags.length;
    } else if (flags.length > 0) {
      red_flags_count += flags.length;
    }

    inserts.push({
      tenant_id: user.tenantId,
      icp_id: parsed.data.icp_id,
      discovery_run_id: runRow.id,
      discovery_source: "manual_upload",
      company_name: row.company_name,
      domain: normalizedDomain,
      website_url: row.website_url,
      industry: row.industry,
      city: row.city,
      region: row.region,
      country_code: marketToCountry(row.market),
      market: row.market,
      language: row.language ?? (row.market === "MX" ? "es" : "en"),
      status: "raw",
      red_flags: flags,
    });
  }

  if (inserts.length > 0) {
    const { error: insertErr } = await supabase.from("prospects").insert(inserts as never);
    if (insertErr) {
      await failRun(runRow.id, `Could not insert prospects: ${insertErr.message}`);
      return { ok: false, error: `Could not insert prospects: ${insertErr.message}` };
    }
  }

  // Close the run.
  const completedAt = new Date().toISOString();
  await supabase
    .from("discovery_runs")
    .update({
      status: "complete",
      candidates_found: parsed.data.rows.length,
      candidates_new,
      candidates_duplicate,
      completed_at: completedAt,
    } as never)
    .eq("id", runRow.id);

  revalidatePath("/discover");
  revalidatePath("/companies");

  return {
    ok: true,
    run_id: runRow.id,
    candidates_found: parsed.data.rows.length,
    candidates_new,
    candidates_duplicate,
    red_flags: red_flags_count,
  };
}

async function failRun(runId: string, msg: string) {
  const supabase = await createClient();
  await supabase
    .from("discovery_runs")
    .update({
      status: "failed",
      error_message: msg,
      completed_at: new Date().toISOString(),
    } as never)
    .eq("id", runId);
}

function marketToCountry(market: "CA" | "MX" | "US" | "LATAM"): string {
  switch (market) {
    case "CA":
      return "CA";
    case "MX":
      return "MX";
    case "US":
      return "US";
    case "LATAM":
      return "MX"; // default until per-row country resolution
  }
}
