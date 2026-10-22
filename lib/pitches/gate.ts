// Send gate v2 — the DB side of lib/pitches/send-gate.ts.
//
// Loads everything the pure gate needs for one pitch (prospect, research
// evidence, the recipient, verified benchmarks, client names), runs it, and
// stores the verdict on the pitch (pitches.gate_verdict) so /pitches can show
// it. Replaces the v1 dry run, which logged verdicts and blocked nothing while
// 38 of the 40 pitches it would have held were sent anyway.
//
// Enforced at (see tasks/audit-2026-10-16.md §5.3):
//   generate / rewrite / website pitch / edit  → verdict stored
//   approve (single)                           → block = refused; review = needs "approve anyway"
//   bulk approve                               → only fully-passing pitches
//   send-queue cron + "Send now"               → re-checked on the exact body and recipient
//   follow-ups + nudges                        → content checks; a failing email isn't sent
//
// Fails CLOSED for sends: if the verdict can't be computed, callers don't send.

import { writeAuditLog } from "@/lib/audit/log";
import { hasUsableEmail, pickAddressContact } from "@/lib/research/email-utils";
import {
  GATE_VERSION,
  evaluateSendGate,
  type GateFailure,
  type GateInput,
  type GateResult,
} from "./send-gate";

// Callers pass either the cookie client (server actions) or the service-role
// client (crons); their generated types differ, so this module takes either.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

export type StoredGateVerdict = {
  version: number;
  pass: boolean;
  checked_at: string;
  failures: GateFailure[];
};

export type GateOverride = { by: string; at: string; codes: string[] };

export type GateRecipient = {
  email: string | null;
  full_name: string | null;
  selected_by: string | null;
};

/** Everything about a prospect the gate reads, loaded once per check. */
export type GateContext = {
  companyName: string;
  domain: string | null;
  lang: "en" | "es";
  siteName: string | null;
  websiteVerified: boolean;
  evidenceQuotes: string[];
  benchmarkSources: string[];
  clientNames: string[];
  topRecipient: GateRecipient | null;
};

/** Pull evidence_quote strings out of the pain_points JSONB. */
function evidenceQuotesFrom(painPoints: unknown): string[] {
  if (!Array.isArray(painPoints)) return [];
  return painPoints
    .map((p) => (p as { evidence_quote?: unknown } | null)?.evidence_quote)
    .filter((q): q is string => typeof q === "string" && q.trim().length > 0);
}

export function parseGateOverride(raw: unknown): GateOverride | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<GateOverride>;
  if (!Array.isArray(o.codes)) return null;
  return { by: String(o.by ?? ""), at: String(o.at ?? ""), codes: o.codes.map(String) };
}

export function parseGateVerdict(raw: unknown): StoredGateVerdict | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Partial<StoredGateVerdict>;
  if (typeof v.pass !== "boolean" || !Array.isArray(v.failures)) return null;
  return {
    version: Number(v.version ?? 0),
    pass: v.pass,
    checked_at: String(v.checked_at ?? ""),
    failures: v.failures as GateFailure[],
  };
}

export function toStoredVerdict(result: GateResult): StoredGateVerdict {
  return {
    version: GATE_VERSION,
    pass: result.pass,
    checked_at: new Date().toISOString(),
    failures: result.pass ? [] : result.failures,
  };
}

/** Tenant-wide gate data: verified benchmarks and client names. */
export type GateShared = { benchmarkSources: string[]; clientNames: string[] };

/**
 * Load the tenant-wide part once (bulk approve checks up to 200 pitches).
 * Null on any error: without client names the client rule can't fire, so a
 * failed lookup must not silently weaken the gate.
 */
export async function loadGateShared(supabase: AnySupabase, tenantId: string): Promise<GateShared | null> {
  const [benchRes, casesRes, notableRes] = await Promise.all([
    supabase
      .from("benchmarks")
      .select("figure, statistic, publisher")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .not("verified_at", "is", null),
    supabase.from("case_studies").select("client_name").eq("tenant_id", tenantId),
    supabase.from("notable_clients").select("name").eq("tenant_id", tenantId),
  ]);
  if (casesRes.error || notableRes.error || benchRes.error) return null;
  const benchmarks = (benchRes.data ?? []) as { figure: string; statistic: string; publisher: string }[];
  const clientNames = [
    ...((casesRes.data ?? []) as { client_name: string | null }[]).map((r) => r.client_name),
    ...((notableRes.data ?? []) as { name: string | null }[]).map((r) => r.name),
  ].filter((n): n is string => typeof n === "string" && n.trim().length > 0);
  return {
    // A verified benchmark's statistic text is a source too ("73% of buyers…").
    // The publisher is too: the prompt asks the model to attribute ("Deloitte
    // Digital + 55 found…"), and a digit in a publisher's name isn't a claim.
    benchmarkSources: benchmarks.flatMap((b) => [b.figure, b.statistic, b.publisher]),
    clientNames: Array.from(new Set(clientNames)),
  };
}

/** Load the gate's view of one prospect. Null when it can't be loaded. */
export async function loadGateContext(
  supabase: AnySupabase,
  tenantId: string,
  prospectId: string,
  sharedIn?: GateShared | null,
): Promise<GateContext | null> {
  const [prospectRes, researchRes, contactsRes, shared] = await Promise.all([
    supabase
      .from("prospects")
      .select("company_name, domain, language")
      .eq("id", prospectId)
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    supabase
      .from("prospect_research")
      .select("last_scraped_at, evidence_urls, pain_points, site_name, what_they_do")
      .eq("prospect_id", prospectId)
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    // Same resolution as the send path: priority_rank order, first usable.
    supabase
      .from("prospect_contacts")
      .select("email, full_name, selected_by, priority_rank")
      .eq("prospect_id", prospectId)
      .eq("tenant_id", tenantId)
      .order("priority_rank", { ascending: true })
      .limit(12),
    sharedIn ?? loadGateShared(supabase, tenantId),
  ]);

  const prospect = prospectRes.data as { company_name: string; domain: string | null; language: string } | null;
  if (prospectRes.error || !prospect || !shared) return null;

  const research = researchRes.data as {
    last_scraped_at: string | null;
    evidence_urls: string[] | null;
    pain_points: unknown;
    site_name: string | null;
    what_they_do: string | null;
  } | null;
  const contacts = (contactsRes.data ?? []) as GateRecipient[];
  const top = pickAddressContact(contacts);

  return {
    companyName: prospect.company_name,
    domain: prospect.domain,
    lang: prospect.language === "es" ? "es" : "en",
    siteName: research?.site_name ?? null,
    // A site we successfully scraped leaves both a timestamp and evidence URLs.
    websiteVerified: Boolean(research?.last_scraped_at && (research.evidence_urls?.length ?? 0) > 0),
    // The research summary is evidence too: "346 beds", "26 locations" come
    // from their own site via what_they_do, which the composer is given.
    evidenceQuotes: [
      ...evidenceQuotesFrom(research?.pain_points),
      ...(research?.what_they_do?.trim() ? [research.what_they_do] : []),
    ],
    benchmarkSources: shared.benchmarkSources,
    clientNames: shared.clientNames,
    topRecipient: top
      ? { email: top.email, full_name: top.full_name, selected_by: top.selected_by }
      : null,
  };
}

/** Build the pure gate's input from a context and the email being checked. */
export function gateInputFor(
  ctx: GateContext,
  email: { subject: string; body: string; recipient?: GateRecipient | null; checkRecipientSource?: boolean },
): GateInput {
  const recipient = email.recipient ?? ctx.topRecipient;
  return {
    subject: email.subject,
    body: email.body,
    lang: ctx.lang,
    recipientEmail: recipient?.email ?? null,
    recipientFullName: recipient?.full_name ?? null,
    recipientSelectedBy: recipient?.selected_by ?? null,
    companyName: ctx.companyName,
    siteName: ctx.siteName,
    domain: ctx.domain,
    websiteVerified: ctx.websiteVerified,
    evidenceQuotes: ctx.evidenceQuotes,
    benchmarkFigures: ctx.benchmarkSources,
    clientNames: ctx.clientNames,
    checkRecipientSource: email.checkRecipientSource,
  };
}

export type PitchGateCheck = {
  result: GateResult;
  verdict: StoredGateVerdict;
  override: GateOverride | null;
};

/**
 * Check one pitch and (by default) store the verdict on it.
 *
 * `body` / `recipient` let a send path check the EXACT text and address going
 * out (after sign-off reconciliation, after re-resolving the contact); without
 * them the stored body and the pitch's own contact (contact_id, the address the
 * send-queue uses) are checked, or the prospect's top contact when the pitch
 * has none with a usable address.
 *
 * Returns null when the pitch or its prospect can't be loaded — callers that
 * send must treat that as "do not send".
 */
export async function checkPitchGate(
  supabase: AnySupabase,
  tenantId: string,
  pitchId: string,
  opts: { body?: string; recipient?: GateRecipient | null; persist?: boolean; shared?: GateShared | null } = {},
): Promise<PitchGateCheck | null> {
  const { data: pitch, error } = await supabase
    .from("pitches")
    .select("subject, body_original, body_edited, prospect_id, contact_id, gate_override")
    .eq("id", pitchId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !pitch) return null;
  const row = pitch as {
    subject: string;
    body_original: string | null;
    body_edited: string | null;
    prospect_id: string;
    contact_id?: string | null;
    gate_override: unknown;
  };

  const ctx = await loadGateContext(supabase, tenantId, row.prospect_id, opts.shared);
  if (!ctx) return null;

  let recipient = opts.recipient;
  if (recipient === undefined && row.contact_id) {
    const { data: own } = await supabase
      .from("prospect_contacts")
      .select("email, full_name, selected_by")
      .eq("id", row.contact_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const c = own as GateRecipient | null;
    if (c && hasUsableEmail(c.email)) recipient = c;
  }

  const result = evaluateSendGate(
    gateInputFor(ctx, {
      subject: row.subject,
      body: opts.body ?? row.body_edited ?? row.body_original ?? "",
      recipient,
    }),
  );
  const verdict = toStoredVerdict(result);

  if (opts.persist !== false) {
    await supabase
      .from("pitches")
      .update({ gate_verdict: verdict } as never)
      .eq("id", pitchId)
      .eq("tenant_id", tenantId);
  }

  return { result, verdict, override: parseGateOverride(row.gate_override) };
}

/**
 * Store a fresh verdict after the text changed (generate, rewrite, edit) and
 * drop any approve-anyway: it accepted flags on text that no longer exists.
 * Best-effort — a failure here must not lose the edit; approve and send
 * re-check anyway.
 */
export async function refreshGateAfterChange(
  supabase: AnySupabase,
  tenantId: string,
  pitchId: string,
): Promise<StoredGateVerdict | null> {
  try {
    await supabase
      .from("pitches")
      .update({ gate_override: null } as never)
      .eq("id", pitchId)
      .eq("tenant_id", tenantId);
    const check = await checkPitchGate(supabase, tenantId, pitchId);
    return check?.verdict ?? null;
  } catch (err) {
    console.warn("[gate] refresh skipped:", (err as Error).message);
    return null;
  }
}

/** Audit a send-time hold so the gate's decisions can be reviewed later. */
export async function auditGateHold(params: {
  tenantId: string;
  actorId: string | null;
  pitchId: string;
  path: string;
  failures: GateFailure[];
}): Promise<void> {
  await writeAuditLog({
    tenantId: params.tenantId,
    actorId: params.actorId,
    action: "pitch.gate_held",
    entityType: "pitch",
    entityId: params.pitchId,
    metadata: {
      path: params.path,
      gate_version: GATE_VERSION,
      failure_codes: params.failures.map((f) => f.code),
      failures: params.failures,
    },
  });
}
