// Send-gate DRY RUN.
//
// Evaluates the pre-send verification gate against a freshly-generated pitch and
// records the verdict to audit_log. It changes NOTHING: no pitch is blocked, no
// status moves, no send is skipped. The point is to collect evidence — over a
// couple of weeks of real pitches — that the gate agrees with Pedro's judgement
// BEFORE it is ever allowed to auto-send.
//
// Two questions the logged data answers:
//   1. False positives — would the gate have held pitches Pedro was happy with?
//      (If this isn't ~zero, auto-send would silently throttle good outreach.)
//   2. True positives — did it catch anything Pedro approved that it shouldn't
//      have? (Every bug this session was approved by a human who didn't spot it.)
//
// Deliberately best-effort: any failure here is swallowed. A diagnostic must
// never break pitch generation.

import type { createClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/lib/audit/log";
import { evaluateSendGate, type GateInput } from "./send-gate";
import { fetchActiveBenchmarkFigures } from "@/lib/benchmarks/queries";

type Client = Awaited<ReturnType<typeof createClient>>;

type PitchRow = {
  subject: string;
  body_original: string | null;
  body_edited: string | null;
  prospect_id: string;
};

type ProspectRow = { company_name: string; domain: string | null };

type ResearchRow = {
  last_scraped_at: string | null;
  evidence_urls: string[] | null;
  pain_points: unknown;
  site_name: string | null;
};

type ContactRow = {
  email: string | null;
  full_name: string | null;
  selected_by: string | null;
  priority_rank: number | null;
};

/** Pull evidence_quote strings out of the pain_points JSONB. */
function evidenceQuotesFrom(painPoints: unknown): string[] {
  if (!Array.isArray(painPoints)) return [];
  return painPoints
    .map((p) => (p as { evidence_quote?: unknown } | null)?.evidence_quote)
    .filter((q): q is string => typeof q === "string" && q.trim().length > 0);
}

/**
 * Evaluate the gate for one pitch and log the verdict. Never throws.
 *
 * @returns the verdict, for callers that want to surface it immediately.
 */
export async function recordGateDryRun(
  supabase: Client,
  tenantId: string,
  actorId: string | null,
  pitchId: string,
): Promise<{ pass: boolean; codes: string[] } | null> {
  try {
    const { data: pitch } = await supabase
      .from("pitches")
      .select("subject, body_original, body_edited, prospect_id")
      .eq("id", pitchId)
      .eq("tenant_id", tenantId)
      .maybeSingle<PitchRow>();
    if (!pitch) return null;

    const { data: prospect } = await supabase
      .from("prospects")
      .select("company_name, domain")
      .eq("id", pitch.prospect_id)
      .eq("tenant_id", tenantId)
      .maybeSingle<ProspectRow>();
    if (!prospect) return null;

    const { data: research } = await supabase
      .from("prospect_research")
      .select("last_scraped_at, evidence_urls, pain_points, site_name")
      .eq("prospect_id", pitch.prospect_id)
      .eq("tenant_id", tenantId)
      .maybeSingle<ResearchRow>();

    // Resolve the recipient the SAME way the send path does: priority_rank
    // order, first usable. Fetch selected_by too — provenance decides whether
    // an address is trustworthy enough to auto-send.
    const { data: contacts } = await supabase
      .from("prospect_contacts")
      .select("email, full_name, selected_by, priority_rank")
      .eq("prospect_id", pitch.prospect_id)
      .eq("tenant_id", tenantId)
      .order("priority_rank", { ascending: true })
      .limit(12)
      .returns<ContactRow[]>();

    const { pickAddressContact } = await import("@/lib/research/email-utils");
    const top = pickAddressContact(contacts ?? []);

    // A site we successfully scraped leaves both a timestamp and evidence URLs.
    const websiteVerified = Boolean(
      research?.last_scraped_at && (research.evidence_urls?.length ?? 0) > 0,
    );

    const input: GateInput = {
      subject: pitch.subject,
      body: pitch.body_edited ?? pitch.body_original ?? "",
      recipientEmail: top?.email ?? null,
      recipientFullName: top?.full_name ?? null,
      recipientSelectedBy: top?.selected_by ?? null,
      companyName: prospect.company_name,
      // Persisted since migration 0027. Before that this was hardcoded null, so
      // rule 4 — "stored company name contradicts the site's own name" — never
      // fired once, despite being exactly the guard that catches a prospect
      // whose discovered domain belongs to someone else (Corvex Manufacturing
      // stored against linamar.com). Null for rows scraped before 0027, and the
      // gate correctly skips the rule rather than guessing.
      siteName: research?.site_name ?? null,
      domain: prospect.domain,
      websiteVerified,
      evidenceQuotes: evidenceQuotesFrom(research?.pain_points),
      // Verified benchmarks are a legitimate source for a figure — without them
      // rule 5 flags every number, including the ones we can actually defend.
      benchmarkFigures: await fetchActiveBenchmarkFigures(supabase, tenantId),
    };

    const verdict = evaluateSendGate(input);
    const codes = verdict.pass ? [] : verdict.failures.map((f) => f.code);

    await writeAuditLog({
      tenantId,
      actorId,
      action: "pitch.gate_dryrun",
      entityType: "pitch",
      entityId: pitchId,
      metadata: {
        pass: verdict.pass,
        failure_codes: codes,
        failures: verdict.pass ? [] : verdict.failures,
        recipient: input.recipientEmail,
        recipient_source: input.recipientSelectedBy,
        website_verified: websiteVerified,
        // Recorded so a later rule change can be compared against old verdicts.
        gate_version: 1,
      },
    });

    return { pass: verdict.pass, codes };
  } catch (err) {
    console.warn("[gate-dryrun] skipped:", (err as Error).message);
    return null;
  }
}
