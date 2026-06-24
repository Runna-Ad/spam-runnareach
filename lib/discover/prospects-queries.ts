import { createClient } from "@/lib/supabase/server";
import { hasUsableEmail } from "@/lib/research/email-utils";

export type Prospect = {
  id: string;
  company_name: string;
  domain: string | null;
  website_url: string | null;
  industry: string | null;
  city: string | null;
  region: string | null;
  market: "CA" | "MX" | "US" | "LATAM";
  status: string;
  match_score: number | null;
  red_flags: string[];
  discovery_source: string;
  icp_id: string | null;
  icp_name: string | null;
  created_at: string;
  /**
   * Most actionable pitch state for this prospect, if any pitch exists:
   * "queued_for_approval" (needs review) > "approved" (ready) > "sent". Null
   * if no pitch or only drafts. Lets /companies flag what's awaiting approval
   * without conflating it with the prospect's funnel status.
   */
  pitch_status: "queued_for_approval" | "approved" | "queued_to_send" | "sent" | null;
  /** True if at least one contact with an email is attached — i.e. reachable. */
  has_contact: boolean;
  /** True when the ONLY emailed contact(s) are unverified catch-all guesses. */
  contact_is_guess: boolean;
};

export type ProspectFilters = {
  status?: string;
  market?: "CA" | "MX" | "US" | "LATAM";
  icpId?: string;
  search?: string;
};

export type ProspectSort = "score_desc" | "score_asc" | "newest" | "oldest" | "name";

export async function listProspects(
  tenantId: string,
  filters: ProspectFilters = {},
  sort: ProspectSort = "newest",
  limit = 100,
): Promise<Prospect[]> {
  const supabase = await createClient();

  type Row = {
    id: string;
    company_name: string;
    domain: string | null;
    website_url: string | null;
    industry: string | null;
    city: string | null;
    region: string | null;
    market: "CA" | "MX" | "US" | "LATAM";
    status: string;
    match_score: number | null;
    red_flags: string[];
    discovery_source: string;
    icp_id: string | null;
    created_at: string;
    icps: { name: string } | null;
    pitches: { status: string }[] | null;
    prospect_contacts: { email: string | null; selected_by: string | null }[] | null;
  };

  let query = supabase
    .from("prospects")
    .select(
      `
      id, company_name, domain, website_url, industry, city, region, market,
      status, match_score, red_flags, discovery_source, icp_id, created_at,
      icps(name), pitches(status, scheduled_send_at), prospect_contacts(email, selected_by)
    `,
    )
    .eq("tenant_id", tenantId)
    .limit(limit);

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.market) query = query.eq("market", filters.market);
  if (filters.icpId) query = query.eq("icp_id", filters.icpId);
  if (filters.search) {
    const term = filters.search.replace(/[%_]/g, " ").trim();
    if (term.length > 0) {
      query = query.or(`company_name.ilike.%${term}%,domain.ilike.%${term}%`);
    }
  }

  switch (sort) {
    case "score_desc":
      query = query.order("match_score", { ascending: false, nullsFirst: false });
      break;
    case "score_asc":
      query = query.order("match_score", { ascending: true, nullsFirst: true });
      break;
    case "oldest":
      query = query.order("created_at", { ascending: true });
      break;
    case "name":
      query = query.order("company_name", { ascending: true });
      break;
    case "newest":
    default:
      query = query.order("created_at", { ascending: false });
      break;
  }

  const { data, error } = await query.returns<Row[]>();
  if (error) throw new Error(`Failed to load prospects: ${error.message}`);
  if (!data) return [];

  return data.map((r) => ({
    id: r.id,
    company_name: r.company_name,
    domain: r.domain,
    website_url: r.website_url,
    industry: r.industry,
    city: r.city,
    region: r.region,
    market: r.market,
    status: r.status,
    match_score: r.match_score,
    red_flags: r.red_flags,
    discovery_source: r.discovery_source,
    icp_id: r.icp_id,
    icp_name: r.icps?.name ?? null,
    created_at: r.created_at,
    pitch_status: derivePitchStatus(r.pitches),
    has_contact: (r.prospect_contacts ?? []).some((c) => hasUsableEmail(c.email)),
    contact_is_guess: (() => {
      const emailed = (r.prospect_contacts ?? []).filter((c) => !!c.email);
      return (
        emailed.length > 0 &&
        emailed.every((c) => c.selected_by === "snapverify_catchall_guess")
      );
    })(),
  }));
}

/** Pick the most actionable pitch state across a prospect's pitches. */
function derivePitchStatus(
  pitches: { status: string; scheduled_send_at?: string | null }[] | null,
): "queued_for_approval" | "approved" | "queued_to_send" | "sent" | null {
  if (!pitches || pitches.length === 0) return null;
  // Show the MOST-ADVANCED state across this prospect's pitches. "Queued to
  // send" = an approved pitch with a scheduled_send_at (status stays 'approved'
  // until the drip cron flips it to 'sent').
  if (pitches.some((p) => p.status === "sent")) return "sent";
  if (pitches.some((p) => p.status === "approved" && p.scheduled_send_at)) return "queued_to_send";
  if (pitches.some((p) => p.status === "approved")) return "approved";
  if (pitches.some((p) => p.status === "queued_for_approval")) return "queued_for_approval";
  return null;
}

export async function countProspects(tenantId: string): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("prospects")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  if (error) throw new Error(`Failed to count prospects: ${error.message}`);
  return count ?? 0;
}
