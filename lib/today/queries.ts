import { createClient } from "@/lib/supabase/server";

/**
 * Counts grouped by prospect.status for the dashboard pipeline strip.
 * RLS filters to the user's tenant automatically.
 */
export async function getStatusCounts(
  tenantId: string,
): Promise<Record<string, number>> {
  const supabase = await createClient();
  type Row = { status: string };
  const { data, error } = await supabase
    .from("prospects")
    .select("status")
    .eq("tenant_id", tenantId)
    .returns<Row[]>();

  if (error) throw new Error(`Failed to load status counts: ${error.message}`);
  const out: Record<string, number> = {};
  for (const row of data ?? []) {
    out[row.status] = (out[row.status] ?? 0) + 1;
  }
  return out;
}

/**
 * Send-stage counts for the pipeline strip — these are PITCH-level states, not
 * prospect.status (sending never changes prospect.status), so they're derived
 * from the pitches table. Counted as DISTINCT prospects to match the strip's
 * prospect orientation:
 *   - queued_to_send: prospects with an approved + scheduled pitch, not yet sent
 *   - sent:           prospects with at least one sent pitch
 */
export async function getSendStageCounts(
  tenantId: string,
): Promise<{ queued_to_send: number; sent: number }> {
  const supabase = await createClient();
  type Row = { prospect_id: string; status: string; scheduled_send_at: string | null };
  const { data, error } = await supabase
    .from("pitches")
    .select("prospect_id, status, scheduled_send_at")
    .eq("tenant_id", tenantId)
    .returns<Row[]>();

  if (error) throw new Error(`Failed to load send-stage counts: ${error.message}`);
  const rows = data ?? [];
  const sent = new Set<string>();
  for (const r of rows) if (r.status === "sent") sent.add(r.prospect_id);
  const queued = new Set<string>();
  for (const r of rows) {
    if (r.status === "approved" && r.scheduled_send_at && !sent.has(r.prospect_id)) {
      queued.add(r.prospect_id);
    }
  }
  return { queued_to_send: queued.size, sent: sent.size };
}

export type AttentionRow = {
  id: string;
  company_name: string;
  domain: string | null;
  market: "CA" | "MX" | "US" | "LATAM";
  status: string;
  match_score: number | null;
  age_days: number;
  reason: "needs_research" | "stale_research" | "ready_to_pitch";
};

/**
 * Build the "Needs your attention" queue. Three buckets, surfaced in priority
 * order:
 *   1. ready_to_pitch — researched + match_score >= 60, not yet pitched
 *   2. needs_research — status='raw' (oldest first — these are rotting)
 *   3. stale_research — status='researched' but research is older than 14d
 *
 * Capped at 12 rows so the panel stays compact. Pedro can drill into
 * /companies for the full list.
 */
export async function getAttentionQueue(
  tenantId: string,
  limit = 12,
): Promise<AttentionRow[]> {
  const supabase = await createClient();

  type Row = {
    id: string;
    company_name: string;
    domain: string | null;
    market: "CA" | "MX" | "US" | "LATAM";
    status: string;
    match_score: number | null;
    created_at: string;
  };

  // Pull a wider net, then bucket+rank in JS — avoids 3 round-trips and the
  // dataset is small (current pipeline ~hundreds, not thousands).
  const { data, error } = await supabase
    .from("prospects")
    .select("id, company_name, domain, market, status, match_score, created_at")
    .eq("tenant_id", tenantId)
    .in("status", ["raw", "researched"])
    .order("created_at", { ascending: true })
    .returns<Row[]>();

  if (error) throw new Error(`Failed to load attention queue: ${error.message}`);

  const now = Date.now();
  const dayMs = 86_400_000;
  const out: AttentionRow[] = [];

  for (const r of data ?? []) {
    const ageDays = Math.floor((now - new Date(r.created_at).getTime()) / dayMs);
    let reason: AttentionRow["reason"] | null = null;

    if (r.status === "researched" && (r.match_score ?? 0) >= 60) {
      reason = "ready_to_pitch";
    } else if (r.status === "raw") {
      reason = "needs_research";
    } else if (r.status === "researched" && ageDays >= 14) {
      reason = "stale_research";
    }

    if (reason) {
      out.push({
        id: r.id,
        company_name: r.company_name,
        domain: r.domain,
        market: r.market,
        status: r.status,
        match_score: r.match_score,
        age_days: ageDays,
        reason,
      });
    }
  }

  // Priority ordering: ready_to_pitch first, then oldest needs_research,
  // then stale_research.
  const priority: Record<AttentionRow["reason"], number> = {
    ready_to_pitch: 0,
    needs_research: 1,
    stale_research: 2,
  };
  out.sort((a, b) => {
    if (priority[a.reason] !== priority[b.reason]) {
      return priority[a.reason] - priority[b.reason];
    }
    if (a.reason === "ready_to_pitch") {
      return (b.match_score ?? 0) - (a.match_score ?? 0);
    }
    return b.age_days - a.age_days;
  });

  return out.slice(0, limit);
}

export type RecentProspect = {
  id: string;
  company_name: string;
  domain: string | null;
  market: "CA" | "MX" | "US" | "LATAM";
  status: string;
  discovery_source: string;
  created_at: string;
};

/**
 * Last N prospects added to the pipeline, regardless of status. Powers the
 * "Recently added" sidebar.
 */
export async function getRecentProspects(
  tenantId: string,
  limit = 6,
): Promise<RecentProspect[]> {
  const supabase = await createClient();
  type Row = RecentProspect;
  const { data, error } = await supabase
    .from("prospects")
    .select("id, company_name, domain, market, status, discovery_source, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limit)
    .returns<Row[]>();
  if (error) throw new Error(`Failed to load recent prospects: ${error.message}`);
  return data ?? [];
}

/**
 * Count of prospects added in the last 7 days — for the "this week" stat tile.
 */
export async function countAddedThisWeek(tenantId: string): Promise<number> {
  const supabase = await createClient();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { count, error } = await supabase
    .from("prospects")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .gte("created_at", since);
  if (error) throw new Error(`Failed to count this-week: ${error.message}`);
  return count ?? 0;
}

export type TenantActivityEntry = {
  id: string;
  kind:
    | "scrape"
    | "score"
    | "status_change"
    | "research_edit"
    | "research_create"
    | "structured_research"
    | "pitch_generated"
    | "reply_created"
    | "prospect_update"
    | "other";
  label: string;
  detail: string | null;
  prospect_id: string | null;
  prospect_name: string | null;
  actor_name: string | null;
  at: string;
};

/**
 * Tenant-wide audit roll-up — last N events across all prospects, used
 * by the /today activity feed. Filters out noise:
 *   - prospect.updated (too chatty — every field tweak shows up)
 * Includes:
 *   - prospect.scraped, scored, status_changed
 *   - research.created/edited
 *   - "kind=structured_research" + "kind=pitch.generated" + "kind=reply.created"
 *     (currently piggy-backed on prospect.scored action with a metadata.kind
 *     marker — clean up when Phase 2 adds canonical action codes)
 *
 * Joins prospect name + actor full_name when available.
 */
export async function listTenantActivity(
  tenantId: string,
  limit = 20,
): Promise<TenantActivityEntry[]> {
  const supabase = await createClient();

  type Row = {
    id: string;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
    users: { full_name: string | null } | null;
  };

  const { data, error } = await supabase
    .from("audit_log")
    .select(
      "id, action, entity_type, entity_id, metadata, created_at, users(full_name)",
    )
    .eq("tenant_id", tenantId)
    .neq("action", "prospect.updated")
    .order("created_at", { ascending: false })
    .limit(limit * 2) // pull extra so we can drop noise + still hit limit
    .returns<Row[]>();

  if (error) throw new Error(`Failed to load tenant activity: ${error.message}`);

  // Collect prospect ids referenced (some rows have prospect_id in
  // metadata for research-entity events; some have it as entity_id).
  const prospectIds = new Set<string>();
  for (const row of data ?? []) {
    if (row.entity_type === "prospect" && row.entity_id) {
      prospectIds.add(row.entity_id);
    }
    const meta = row.metadata ?? {};
    if (typeof meta.prospect_id === "string") prospectIds.add(meta.prospect_id);
  }

  // Resolve names in a single query.
  type ProspectRow = { id: string; company_name: string };
  const nameById = new Map<string, string>();
  if (prospectIds.size > 0) {
    const { data: pData } = await supabase
      .from("prospects")
      .select("id, company_name")
      .eq("tenant_id", tenantId)
      .in("id", Array.from(prospectIds))
      .returns<ProspectRow[]>();
    for (const p of pData ?? []) nameById.set(p.id, p.company_name);
  }

  const out: TenantActivityEntry[] = [];
  for (const row of data ?? []) {
    if (out.length >= limit) break;
    const meta = row.metadata ?? {};
    const prospectId =
      row.entity_type === "prospect" && row.entity_id
        ? row.entity_id
        : typeof meta.prospect_id === "string"
          ? meta.prospect_id
          : null;
    const desc = describeTenantAction(row.action, meta);
    if (!desc) continue; // unknown / noise — skip
    out.push({
      id: row.id,
      kind: desc.kind,
      label: desc.label,
      detail: desc.detail,
      prospect_id: prospectId,
      prospect_name: prospectId ? nameById.get(prospectId) ?? null : null,
      actor_name: row.users?.full_name ?? null,
      at: row.created_at,
    });
  }
  return out;
}

function describeTenantAction(
  action: string,
  meta: Record<string, unknown>,
): { kind: TenantActivityEntry["kind"]; label: string; detail: string | null } | null {
  // Sub-routed events (the "kind" piggy-back from Phase 1a).
  const kindHint = typeof meta.kind === "string" ? meta.kind : null;
  if (action === "prospect.scored" && kindHint === "structured_research") {
    const pains = typeof meta.pain_points_added === "number" ? meta.pain_points_added : 0;
    const contacts = typeof meta.contacts_added === "number" ? meta.contacts_added : 0;
    return {
      kind: "structured_research",
      label: "Ran structured research",
      detail: `+${pains} pain${pains === 1 ? "" : "s"} · +${contacts} contact${contacts === 1 ? "" : "s"}`,
    };
  }
  if (action === "prospect.scored" && kindHint === "pitch.generated") {
    const score = typeof meta.quality_self_score === "number"
      ? Math.round(meta.quality_self_score * 100)
      : null;
    return {
      kind: "pitch_generated",
      label: "Generated pitch draft",
      detail: score !== null ? `self-score ${score}%` : null,
    };
  }
  if (action === "prospect.scored" && kindHint === "reply.created") {
    const intent = typeof meta.intent === "string" ? meta.intent : null;
    return {
      kind: "reply_created",
      label: "Logged reply",
      detail: intent ? `intent: ${intent.replace(/_/g, " ")}` : null,
    };
  }

  switch (action) {
    case "prospect.scraped": {
      const tech = typeof meta.tech_count === "number" ? meta.tech_count : 0;
      return {
        kind: "scrape",
        label: "Scraped website",
        detail: tech > 0 ? `${tech} tech detected` : null,
      };
    }
    case "prospect.scored": {
      const score = typeof meta.composite_score === "number" ? meta.composite_score : null;
      return {
        kind: "score",
        label: score !== null ? `Scored ${score}/100` : "Scored",
        detail: typeof meta.method === "string" ? `via ${meta.method}` : null,
      };
    }
    case "prospect.status_changed": {
      const from = typeof meta.from === "string" ? meta.from : null;
      const to = typeof meta.to === "string" ? meta.to : null;
      const via = typeof meta.via === "string" ? meta.via : null;
      return {
        kind: "status_change",
        label: from ? `Status: ${from} → ${to}` : `Status: ${to}`,
        detail: via === "bulk" ? "via bulk" : null,
      };
    }
    case "research.created":
      return { kind: "research_create", label: "Created research", detail: null };
    case "research.edited":
      return { kind: "research_edit", label: "Edited research", detail: null };
    default:
      return null;
  }
}

/**
 * Count of distinct prospects with research scraped in the last 7 days.
 * If the prospect_research table isn't migrated yet, returns 0.
 */
export async function countScrapedThisWeek(tenantId: string): Promise<number> {
  const supabase = await createClient();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { count, error } = await supabase
    .from("prospect_research")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .gte("last_scraped_at", since);
  if (error) {
    if (
      error.code === "42P01" ||
      error.code === "PGRST205" ||
      error.message?.includes("schema cache")
    ) {
      return 0;
    }
    throw new Error(`Failed to count scrapes: ${error.message}`);
  }
  return count ?? 0;
}
