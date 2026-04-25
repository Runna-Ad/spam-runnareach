import { createClient } from "@/lib/supabase/server";

export type ProspectFull = {
  id: string;
  tenant_id: string;
  icp_id: string | null;
  icp_name: string | null;
  discovery_run_id: string | null;
  discovery_source: string;
  company_name: string;
  domain: string | null;
  website_url: string | null;
  industry: string | null;
  employee_size_estimate: number | null;
  address_line: string | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  postal_code: string | null;
  market: "CA" | "MX" | "US" | "LATAM";
  language: "en" | "es";
  status: string;
  research_quality_score: number | null;
  match_score: number | null;
  red_flags: string[];
  pitch_gate_passed: boolean;
  consent_basis: string;
  suppressed_at: string | null;
  suppressed_reason: string | null;
  cooldown_until: string | null;
  cooldown_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type PainPoint = {
  pain_id?: string;
  pain_label?: string;
  evidence_quote?: string;
  evidence_url?: string;
  confidence?: number;
};

export type ProspectResearch = {
  id: string;
  prospect_id: string;
  what_they_do: string | null;
  tech_stack: string[];
  pain_points: PainPoint[];
  notes: string | null;
  research_method: "manual" | "scraped" | "claude_assisted" | string;
  evidence_urls: string[];
  raw_html_snapshot_url: string | null;
  last_scraped_at: string | null;
  last_edited_by_name: string | null;
  created_at: string;
  updated_at: string;
};

export async function getProspect(tenantId: string, id: string): Promise<ProspectFull | null> {
  const supabase = await createClient();

  type Row = Omit<ProspectFull, "icp_name"> & {
    icps: { name: string } | null;
  };

  const { data, error } = await supabase
    .from("prospects")
    .select(
      `
      id, tenant_id, icp_id, discovery_run_id, discovery_source,
      company_name, domain, website_url, industry, employee_size_estimate,
      address_line, city, region, country_code, postal_code, market, language,
      status, research_quality_score, match_score, red_flags, pitch_gate_passed,
      consent_basis, suppressed_at, suppressed_reason,
      cooldown_until, cooldown_reason,
      created_at, updated_at,
      icps(name)
    `,
    )
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle<Row>();

  if (error) throw new Error(`Failed to load prospect: ${error.message}`);
  if (!data) return null;
  return { ...data, icp_name: data.icps?.name ?? null };
}

export async function getProspectResearch(
  tenantId: string,
  prospectId: string,
): Promise<ProspectResearch | null> {
  const supabase = await createClient();

  type Row = Omit<ProspectResearch, "last_edited_by_name" | "pain_points"> & {
    pain_points: unknown;
    users: { full_name: string | null } | null;
  };

  const { data, error } = await supabase
    .from("prospect_research")
    .select(
      `
      id, prospect_id, what_they_do, tech_stack, pain_points, notes,
      research_method, evidence_urls, raw_html_snapshot_url, last_scraped_at,
      created_at, updated_at,
      users(full_name)
    `,
    )
    .eq("tenant_id", tenantId)
    .eq("prospect_id", prospectId)
    .maybeSingle<Row>();

  if (error) {
    // Migration not yet applied. PostgREST returns either:
    //   - 42P01 (raw Postgres error, when going through SQL)
    //   - PGRST205 ("Could not find the table ... in the schema cache")
    if (
      error.code === "42P01" ||
      error.code === "PGRST205" ||
      error.message?.includes("schema cache")
    ) {
      throw new Error("PROSPECT_RESEARCH_TABLE_MISSING");
    }
    throw new Error(`Failed to load research: ${error.message}`);
  }
  if (!data) return null;

  return {
    id: data.id,
    prospect_id: data.prospect_id,
    what_they_do: data.what_they_do,
    tech_stack: data.tech_stack ?? [],
    pain_points: normalizePainPoints(data.pain_points),
    notes: data.notes,
    research_method: data.research_method,
    evidence_urls: data.evidence_urls ?? [],
    raw_html_snapshot_url: data.raw_html_snapshot_url,
    last_scraped_at: data.last_scraped_at,
    last_edited_by_name: data.users?.full_name ?? null,
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

export type ActivityEntry = {
  id: string;
  kind: "discovery" | "research_edit" | "status_change";
  label: string;
  detail: string | null;
  actor_name: string | null;
  at: string;
};

/**
 * Lightweight activity feed pulled from existing tables — no audit_log
 * dependency for this slice. Sources:
 *   - prospects.created_at + discovery_run (creation event)
 *   - prospect_research.updated_at (research edits)
 */
export async function listProspectActivity(
  tenantId: string,
  prospectId: string,
): Promise<ActivityEntry[]> {
  const supabase = await createClient();
  const out: ActivityEntry[] = [];

  type ProspectActivityRow = {
    id: string;
    created_at: string;
    updated_at: string;
    status: string;
    discovery_runs: { source: string; users: { full_name: string | null } | null } | null;
  };

  const { data: p, error: pErr } = await supabase
    .from("prospects")
    .select(
      `
      id, created_at, updated_at, status,
      discovery_runs(source, users(full_name))
    `,
    )
    .eq("tenant_id", tenantId)
    .eq("id", prospectId)
    .maybeSingle<ProspectActivityRow>();

  if (pErr) throw new Error(`Failed to load prospect activity: ${pErr.message}`);

  if (p) {
    out.push({
      id: `created:${p.id}`,
      kind: "discovery",
      label: "Added to pipeline",
      detail: p.discovery_runs?.source
        ? `via ${p.discovery_runs.source.replace(/_/g, " ")}`
        : null,
      actor_name: p.discovery_runs?.users?.full_name ?? null,
      at: p.created_at,
    });
  }

  // Research edits (only if migration applied)
  try {
    type ResRow = {
      id: string;
      created_at: string;
      updated_at: string;
      research_method: string;
      users: { full_name: string | null } | null;
    };
    const { data: research } = await supabase
      .from("prospect_research")
      .select("id, created_at, updated_at, research_method, users(full_name)")
      .eq("tenant_id", tenantId)
      .eq("prospect_id", prospectId)
      .maybeSingle<ResRow>();
    if (research) {
      out.push({
        id: `research:${research.id}`,
        kind: "research_edit",
        label: research.created_at === research.updated_at ? "Research created" : "Research edited",
        detail: research.research_method.replace(/_/g, " "),
        actor_name: research.users?.full_name ?? null,
        at: research.updated_at,
      });
    }
  } catch {
    // table missing — skip
  }

  // Sort newest first
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out;
}

function normalizePainPoints(raw: unknown): PainPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    const out: PainPoint = {};
    if (typeof e.pain_id === "string") out.pain_id = e.pain_id;
    if (typeof e.pain_label === "string") out.pain_label = e.pain_label;
    if (typeof e.evidence_quote === "string") out.evidence_quote = e.evidence_quote;
    if (typeof e.evidence_url === "string") out.evidence_url = e.evidence_url;
    if (typeof e.confidence === "number") out.confidence = e.confidence;
    return Object.keys(out).length > 0 ? [out] : [];
  });
}
