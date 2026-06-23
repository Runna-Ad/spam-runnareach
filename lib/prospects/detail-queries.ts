import { createClient } from "@/lib/supabase/server";
import { isRoleBasedEmail } from "@/lib/research/email-utils";

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

export type PainOption = {
  id: string;
  code: string;
  display_name: string;
  description: string | null;
};

/**
 * Active pain taxonomy entries for the tenant, sorted by display name.
 * Powers the pain-tag picker in the research editor (replaces free-text)
 * and will be the canonical label set Claude classifies into in Phase 2.
 */
export async function listPainTaxonomy(tenantId: string): Promise<PainOption[]> {
  const supabase = await createClient();
  type Row = {
    id: string;
    code: string;
    display_name_en: string;
    description_en: string | null;
  };
  const { data, error } = await supabase
    .from("pain_taxonomy")
    .select("id, code, display_name_en, description_en")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("display_name_en")
    .returns<Row[]>();

  if (error) throw new Error(`Failed to load pain taxonomy: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    code: r.code,
    display_name: r.display_name_en,
    description: r.description_en,
  }));
}

export type ActivityEntry = {
  id: string;
  kind:
    | "discovery"
    | "research_edit"
    | "research_create"
    | "status_change"
    | "scrape"
    | "score"
    | "update";
  label: string;
  detail: string | null;
  actor_name: string | null;
  at: string;
};

/**
 * Activity feed for a prospect. Sources:
 *   - "Added to pipeline" comes from prospects.created_at + discovery_runs
 *     (no audit row needed — bulk CSV uploads would otherwise flood the log)
 *   - All subsequent events come from audit_log filtered to this prospect's
 *     entity_id (status changes, scrapes, scores, research edits, manual
 *     field updates)
 *
 * Newest first. Capped at 50 events — that covers months of activity.
 */
export async function listProspectActivity(
  tenantId: string,
  prospectId: string,
): Promise<ActivityEntry[]> {
  const supabase = await createClient();
  const out: ActivityEntry[] = [];

  // ── Creation event (free — read from prospect + its discovery_run) ──
  type ProspectActivityRow = {
    id: string;
    created_at: string;
    discovery_runs: { source: string; users: { full_name: string | null } | null } | null;
  };
  const { data: p, error: pErr } = await supabase
    .from("prospects")
    .select(
      `
      id, created_at,
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

  // ── Audit log events ─────────────────────────────────────────────────
  // We pull both prospect-targeted entries AND research-targeted entries
  // for THIS prospect (research entries store prospect_id in metadata).
  type AuditRow = {
    id: string;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
    users: { full_name: string | null } | null;
  };

  // Two queries: one for prospect-entity events, one for research-entity
  // events whose metadata.prospect_id matches. We can't do an OR across
  // entity_type and metadata->>prospect_id in a single .or() without
  // ambiguity, so we split.
  const [prospectAudit, researchAudit] = await Promise.all([
    supabase
      .from("audit_log")
      .select("id, action, entity_type, entity_id, metadata, created_at, users(full_name)")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "prospect")
      .eq("entity_id", prospectId)
      .order("created_at", { ascending: false })
      .limit(50)
      .returns<AuditRow[]>(),
    supabase
      .from("audit_log")
      .select("id, action, entity_type, entity_id, metadata, created_at, users(full_name)")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "research")
      // metadata->>prospect_id is the JSON string accessor in PostgREST.
      .eq("metadata->>prospect_id", prospectId)
      .order("created_at", { ascending: false })
      .limit(50)
      .returns<AuditRow[]>(),
  ]);

  for (const row of [...(prospectAudit.data ?? []), ...(researchAudit.data ?? [])]) {
    const { kind, label, detail } = describeAuditAction(row.action, row.metadata);
    out.push({
      id: `audit:${row.id}`,
      kind,
      label,
      detail,
      actor_name: row.users?.full_name ?? null,
      at: row.created_at,
    });
  }

  // Sort newest first, cap at 50.
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out.slice(0, 50);
}

function describeAuditAction(
  action: string,
  metadata: Record<string, unknown> | null,
): { kind: ActivityEntry["kind"]; label: string; detail: string | null } {
  const m = metadata ?? {};
  switch (action) {
    case "prospect.status_changed": {
      const from = typeof m.from === "string" ? m.from : null;
      const to = typeof m.to === "string" ? m.to : null;
      const reason = typeof m.suppressed_reason === "string" ? m.suppressed_reason : null;
      return {
        kind: "status_change",
        label: from ? `Status: ${from} → ${to}` : `Status: ${to}`,
        detail: reason ? `reason: ${reason}` : null,
      };
    }
    case "prospect.scraped": {
      const tech = typeof m.tech_count === "number" ? m.tech_count : 0;
      const emails = typeof m.emails_count === "number" ? m.emails_count : 0;
      return {
        kind: "scrape",
        label: "Website scraped",
        detail: `${tech} tech · ${emails} email${emails === 1 ? "" : "s"}`,
      };
    }
    case "prospect.scored": {
      const score = typeof m.composite_score === "number" ? m.composite_score : null;
      const method = typeof m.method === "string" ? m.method : null;
      return {
        kind: "score",
        label: score !== null ? `Scored ${score}/100` : "Scored",
        detail: method ? `via ${method}` : null,
      };
    }
    case "prospect.updated": {
      const fields = Array.isArray(m.fields) ? (m.fields as string[]) : [];
      return {
        kind: "update",
        label: "Prospect updated",
        detail: fields.length > 0 ? fields.join(", ") : null,
      };
    }
    case "research.edited":
      return { kind: "research_edit", label: "Research edited", detail: null };
    case "research.created":
      return { kind: "research_create", label: "Research created", detail: null };
    default:
      return { kind: "update", label: action, detail: null };
  }
}

export async function getTopContact(
  tenantId: string,
  prospectId: string,
): Promise<{ id: string; email: string; is_role_based: boolean } | null> {
  const supabase = await createClient();
  // Only consider rows that actually HAVE an email. A higher-priority name-only
  // contact (email null — e.g. from people-intel) would otherwise mask a real
  // deliverable address below it, making the prospect look contactless on the
  // Overview even though re-enrich found one. role-based (info@) is fine to
  // surface — it's sendable with the forwarding ask; priority_rank already ranks
  // a personal address above it.
  const { data } = await supabase
    .from("prospect_contacts")
    .select("id, email, email_is_role_based")
    .eq("tenant_id", tenantId)
    .eq("prospect_id", prospectId)
    .not("email", "is", null)
    .neq("email", "")
    .order("priority_rank", { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string; email: string | null; email_is_role_based: boolean }>();
  if (!data?.email) return null;
  // Re-derive role-based from the address as a safety net (legacy/scraper rows
  // may carry a stale false flag) — keeps the Overview's role warning honest and
  // consistent with the pitch composer's pitch-time re-derivation.
  return {
    id: data.id,
    email: data.email,
    is_role_based: data.email_is_role_based || isRoleBasedEmail(data.email),
  };
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
