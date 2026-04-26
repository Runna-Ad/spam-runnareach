import { createClient } from "@/lib/supabase/server";

export type ReplyIntent =
  | "wants_meeting"
  | "wants_info"
  | "hard_no"
  | "not_now"
  | "wrong_person"
  | "auto_reply"
  | "unclassified";

export type ReplyUrgency = "hot" | "warm" | "cold" | null;
export type ReplySentiment = "positive" | "neutral" | "negative" | null;

export type Reply = {
  id: string;
  prospect_id: string | null;
  prospect_name: string | null;
  prospect_market: "CA" | "MX" | "US" | "LATAM" | null;
  pitch_id: string | null;
  from_email: string;
  subject: string | null;
  body_text: string | null;
  received_at: string;
  intent: ReplyIntent;
  urgency: ReplyUrgency;
  sentiment: ReplySentiment;
  classified_at: string | null;
  handled_by: string | null;
  handled_at: string | null;
  handled_by_name: string | null;
};

const REPLIES_TABLE_MISSING = "REPLIES_TABLE_MISSING";

function isMigrationMissingError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    Boolean(err.message?.includes("schema cache"))
  );
}

/**
 * Newest-first list of replies for the tenant. Caps at 200 — beyond that
 * the inbox UX should add filtering/pagination (Phase 4).
 */
export async function listReplies(tenantId: string): Promise<Reply[]> {
  const supabase = await createClient();
  type Row = Omit<Reply, "prospect_name" | "prospect_market" | "handled_by_name"> & {
    prospects: {
      company_name: string;
      market: "CA" | "MX" | "US" | "LATAM";
    } | null;
    handled_user: { full_name: string | null } | null;
  };

  const { data, error } = await supabase
    .from("replies")
    .select(
      `
      id, prospect_id, pitch_id, from_email, subject, body_text,
      received_at, intent, urgency, sentiment, classified_at,
      handled_by, handled_at,
      prospects(company_name, market),
      handled_user:users!replies_handled_by_fkey(full_name)
    `,
    )
    .eq("tenant_id", tenantId)
    .order("received_at", { ascending: false })
    .limit(200)
    .returns<Row[]>();

  if (error) {
    if (isMigrationMissingError(error)) throw new Error(REPLIES_TABLE_MISSING);
    throw new Error(`Failed to load replies: ${error.message}`);
  }

  return (data ?? []).map((r) => ({
    id: r.id,
    prospect_id: r.prospect_id,
    prospect_name: r.prospects?.company_name ?? null,
    prospect_market: r.prospects?.market ?? null,
    pitch_id: r.pitch_id,
    from_email: r.from_email,
    subject: r.subject,
    body_text: r.body_text,
    received_at: r.received_at,
    intent: r.intent,
    urgency: r.urgency,
    sentiment: r.sentiment,
    classified_at: r.classified_at,
    handled_by: r.handled_by,
    handled_at: r.handled_at,
    handled_by_name: r.handled_user?.full_name ?? null,
  }));
}

/**
 * Lightweight prospect picker for the create-reply drawer. Just (id, name,
 * market) for the most-recent 100 prospects so the dropdown stays snappy.
 */
export type ProspectOption = {
  id: string;
  company_name: string;
  market: "CA" | "MX" | "US" | "LATAM";
};

export async function listProspectsForPicker(
  tenantId: string,
): Promise<ProspectOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("prospects")
    .select("id, company_name, market")
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })
    .limit(100)
    .returns<ProspectOption[]>();

  if (error) throw new Error(`Failed to load prospects: ${error.message}`);
  return data ?? [];
}

/**
 * Counts grouped by intent — drives the inbox sidebar tally.
 */
export async function getInboxCounts(
  tenantId: string,
): Promise<{ total: number; unclassified: number; hot: number; unhandled: number }> {
  const supabase = await createClient();

  type Row = {
    intent: ReplyIntent;
    urgency: ReplyUrgency;
    handled_at: string | null;
  };

  const { data, error } = await supabase
    .from("replies")
    .select("intent, urgency, handled_at")
    .eq("tenant_id", tenantId)
    .returns<Row[]>();

  if (error) {
    if (isMigrationMissingError(error)) {
      return { total: 0, unclassified: 0, hot: 0, unhandled: 0 };
    }
    throw new Error(`Failed to count replies: ${error.message}`);
  }

  const rows = data ?? [];
  return {
    total: rows.length,
    unclassified: rows.filter((r) => r.intent === "unclassified").length,
    hot: rows.filter((r) => r.urgency === "hot" || r.intent === "wants_meeting").length,
    unhandled: rows.filter((r) => !r.handled_at).length,
  };
}

export const REPLIES_MIGRATION_MISSING_CODE = REPLIES_TABLE_MISSING;
