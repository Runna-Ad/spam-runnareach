"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { processSingleProspect } from "@/lib/discover/pipeline-action";
import { normalizeDomain } from "@/lib/discover/fuzzy-dedupe";
import type { HunterScan } from "./types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractDomain(url: string): string {
  try {
    const parsed = new URL(
      url.startsWith("http") ? url : `https://${url}`,
    );
    return parsed.hostname.replace(/^www\./, "") || url;
  } catch {
    // fallback: strip protocol and trailing slashes manually
    return (
      url
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/$/, "")
        .split("/")[0] ?? url
    );
  }
}

function toMarket(raw: string): "CA" | "MX" | "US" | "LATAM" {
  switch (raw.toLowerCase()) {
    case "ca":
      return "CA";
    case "mx":
      return "MX";
    default:
      return "CA";
  }
}

/** Returns an existing prospect id if the tenant already has one for this domain. */
async function findExistingProspect(
  domain: string,
  tenantId: string,
): Promise<string | null> {
  const supabase = await createClient();
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;

  const { data } = await supabase
    .from("prospects")
    .select("id, domain")
    .eq("tenant_id", tenantId)
    .not("domain", "is", null)
    .returns<{ id: string; domain: string | null }[]>();

  if (!data) return null;

  for (const row of data) {
    if (row.domain && normalizeDomain(row.domain) === normalized) {
      return row.id;
    }
  }
  return null;
}

// ── addHunterScanToPipeline ────────────────────────────────────────────────────

export async function addHunterScanToPipeline(
  scanId: string,
): Promise<{ ok: boolean; error?: string; prospectId?: string }> {
  try {
    // 1. Fetch scan with service-role (bypasses RLS)
    // hunter_scans is not in generated types — use any for raw access
    const serviceClient = createServiceRoleClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: scanData, error: scanError } = (await (serviceClient as any)
      .from("hunter_scans")
      .select("*")
      .eq("id", scanId)
      .single()) as { data: HunterScan | null; error: { message: string } | null };

    if (scanError || !scanData) {
      return { ok: false, error: "Scan not found." };
    }

    const scan = scanData;

    // 2. Validate
    if (!scan.website_url) {
      return {
        ok: false,
        error: "This scan has no website URL and cannot be added to the pipeline.",
      };
    }

    // 3. Auth
    const user = await requireUser();
    const domain = extractDomain(scan.website_url);

    // 4. Deduplicate
    const existing = await findExistingProspect(domain, user.tenantId);
    if (existing) {
      return { ok: true, prospectId: existing };
    }

    // 5. Insert prospect
    const supabase = await createClient();
    const { data: inserted, error: insertError } = await supabase
      .from("prospects")
      .insert({
        company_name: domain,
        domain,
        website_url: scan.website_url,
        market: toMarket(scan.market),
        industry: scan.industry,
        discovery_source: "hunter" as const,
        status: "raw",
        tenant_id: user.tenantId,
        red_flags: [`hunter_scan:${scanId}`],
      })
      .select("id")
      .single<{ id: string }>();

    if (insertError || !inserted) {
      return { ok: false, error: `Failed to insert prospect: ${insertError?.message}` };
    }

    const prospectId = inserted.id;

    // 6. Kick off pipeline
    await processSingleProspect(prospectId);

    // 7. Revalidate
    revalidatePath("/opportunities");

    return { ok: true, prospectId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ── markHunterScanAsWin ────────────────────────────────────────────────────────

export async function markHunterScanAsWin(
  scanId: string,
): Promise<{ ok: boolean; error?: string; prospectId?: string }> {
  try {
    // 1. Fetch scan
    const serviceClient = createServiceRoleClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: scanData, error: scanError } = (await (serviceClient as any)
      .from("hunter_scans")
      .select("*")
      .eq("id", scanId)
      .single()) as { data: HunterScan | null; error: { message: string } | null };

    if (scanError || !scanData) {
      return { ok: false, error: "Scan not found." };
    }

    const scan = scanData;

    // Validate: must have been contacted
    if (!scan.contacted) {
      return {
        ok: false,
        error: "Scan must be marked as contacted before recording a win.",
      };
    }

    if (!scan.website_url) {
      return {
        ok: false,
        error: "This scan has no website URL and cannot be added to the pipeline.",
      };
    }

    // 2. Auth
    const user = await requireUser();
    const domain = extractDomain(scan.website_url);

    // 3. Deduplicate
    const existing = await findExistingProspect(domain, user.tenantId);
    if (existing) {
      return { ok: true, prospectId: existing };
    }

    // 4. Insert prospect as already booked
    const supabase = await createClient();
    const { data: inserted, error: insertError } = await supabase
      .from("prospects")
      .insert({
        company_name: domain,
        domain,
        website_url: scan.website_url,
        market: toMarket(scan.market),
        industry: scan.industry,
        discovery_source: "hunter" as const,
        status: "booked",
        tenant_id: user.tenantId,
        red_flags: [`hunter_scan:${scanId}`],
      })
      .select("id")
      .single<{ id: string }>();

    if (insertError || !inserted) {
      return { ok: false, error: `Failed to insert prospect: ${insertError?.message}` };
    }

    const prospectId = inserted.id;

    // NOTE: pipeline is intentionally NOT run — prospect already converted.

    // 5. Revalidate
    revalidatePath("/opportunities");

    return { ok: true, prospectId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
