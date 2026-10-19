// Exemplar memory, the data side: read the candidates, their outcomes, and the
// chosen pitches' text. Selection and scrubbing are pure (./exemplars.ts).
//
// Small reads, tenant-scoped, under ONE shared time budget
// (EXEMPLAR_FETCH_BUDGET_MS) so the writer and critic are never starved:
//   1. recent settled root pitches in the prospect's language (light columns),
//      filtered to the segment in memory (prospect.industry is free text, so
//      SQL cannot match a segment); a prospect suppressed since (opt-out,
//      bounce, a person) is skipped,
//   2. outcome events for every eligible candidate (at most EXEMPLAR_SHORTLIST),
//      so a pitch with a reply is scored even when newer silent sends exist,
//   3. the do-not-contact list for the picked addresses and their domains: an
//      opted-out address is never anyone's example, even when its own
//      unsubscribe event is missing (a manual entry, an opt-out logged on
//      another root pitch),
//   4. subject + body + who it went to, for the (at most two) chosen.
// Never throws: an exemplar is an enhancement, not a dependency. Any failure
// is logged and returns [], and the pitch is written exactly as without
// exemplars. A chosen pitch whose scrubbed text still names its prospect is
// dropped (scrub_failed), never shown.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isTestAddress } from "../compliance/test-addresses.ts";
import { ATTRIBUTION_WINDOW_DAYS, OUTCOME_EVENT_TYPES, type OutcomeEvent } from "../learning/reward.ts";
import {
  EXEMPLAR_SHORTLIST,
  MAX_EXEMPLARS,
  selectExemplars,
  shortlistCandidates,
  toExemplar,
  type Exemplar,
  type ExemplarCandidate,
  type ExemplarTarget,
} from "./exemplars.ts";

/** Recent sends scanned for a segment match. */
const CANDIDATE_SCAN = 200;
/** All three reads together, inside the 48s compose budget; normally ~0.1s. */
export const EXEMPLAR_FETCH_BUDGET_MS = 3_000;

/**
 * The candidate columns. The weekly report's readiness count
 * (lib/reports/snapshot.ts) reads the same ones, so both map rows alike.
 */
export const EXEMPLAR_CANDIDATE_COLUMNS =
  "id, prospect_id, parent_pitch_id, status, sent_at, critic_pass:decision->critic->pass, gate_override, prospects!inner(industry, market, language, status), prospect_contacts:contact_id(email)";

export type CandidateRow = {
  id: string;
  prospect_id: string;
  parent_pitch_id: string | null;
  status: string;
  sent_at: string | null;
  critic_pass: boolean | null;
  gate_override: unknown;
  prospects: { industry: string | null; market: string | null; language: string; status: string | null } | null;
  prospect_contacts: { email: string | null } | null;
};

type TextRow = {
  id: string;
  subject: string;
  body_original: string;
  body_edited: string | null;
  prospects: { company_name: string | null; domain: string | null; website_url: string | null; city: string | null } | null;
  prospect_contacts: { full_name: string | null; email: string | null } | null;
};

/** A gate_override with at least one accepted code: a person waved a rule through. */
function overridden(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const codes = (v as { codes?: unknown }).codes;
  return Array.isArray(codes) ? codes.length > 0 : true;
}

/**
 * One candidate row as the selector sees it; null when the prospect was
 * suppressed since (opt-out, bounce, a person): never anyone's example.
 */
export function candidateFromRow(r: CandidateRow): ExemplarCandidate | null {
  if (r.prospects?.status === "suppressed") return null;
  return {
    pitch_id: r.id,
    prospect_id: r.prospect_id,
    parent_pitch_id: r.parent_pitch_id,
    status: r.status,
    sent_at: r.sent_at,
    lang: r.prospects?.language ?? "",
    industry: r.prospects?.industry ?? null,
    market: r.prospects?.market ?? null,
    recipient_email: r.prospect_contacts?.email ?? null,
    critic_pass: typeof r.critic_pass === "boolean" ? r.critic_pass : null,
    gate_overridden: overridden(r.gate_override),
  };
}

/** The kill switch: off unless EXEMPLARS_ENABLED=1 in Vercel. */
export function exemplarsEnabled(): boolean {
  return process.env.EXEMPLARS_ENABLED === "1";
}

export type DncEntries = { emails: Set<string>; domains: Set<string> };

const mailbox = (email: string | null | undefined) => (email ?? "").trim().toLowerCase();
const domainOf = (mailboxAddress: string) => mailboxAddress.split("@")[1] ?? "";

/** True when the address, or its whole domain, is on the do-not-contact list (same match as isEmailOnDncList). */
export function onDnc(dnc: DncEntries, email: string | null | undefined): boolean {
  const m = mailbox(email);
  if (!m.includes("@")) return false;
  return dnc.emails.has(m) || dnc.domains.has(domainOf(m));
}

/** What to look up on the do-not-contact list for these addresses: their mailboxes and domains, normalized as onDnc matches. */
export function dncKeys(emails: ReadonlyArray<string | null | undefined>): { mailboxes: string[]; domains: string[] } {
  const mailboxes = [...new Set(emails.map(mailbox).filter((m) => m.includes("@")))];
  return { mailboxes, domains: [...new Set(mailboxes.map(domainOf).filter(Boolean))] };
}

/** do_not_contact_list rows (by email, by domain) → the entries onDnc reads. */
export function toDncEntries(
  byEmail: ReadonlyArray<{ email: string | null }>,
  byDomain: ReadonlyArray<{ domain: string | null }>,
): DncEntries {
  const out: DncEntries = { emails: new Set(), domains: new Set() };
  for (const r of byEmail) if (r.email) out.emails.add(mailbox(r.email));
  for (const r of byDomain) if (r.domain) out.domains.add(r.domain.trim().toLowerCase());
  return out;
}

/** The do-not-contact entries for these addresses and their domains; null when the lookup failed. */
async function dncEntries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  tenantId: string,
  emails: Array<string | null>,
  signal: AbortSignal,
): Promise<DncEntries | null> {
  const { mailboxes, domains } = dncKeys(emails);
  if (mailboxes.length === 0) return toDncEntries([], []);
  const [byEmail, byDomain] = await Promise.all([
    supabase.from("do_not_contact_list").select("email").eq("tenant_id", tenantId).in("email", mailboxes).abortSignal(signal),
    supabase.from("do_not_contact_list").select("domain").eq("tenant_id", tenantId).in("domain", domains).abortSignal(signal),
  ]);
  if (byEmail.error || byDomain.error) {
    console.error("[exemplars] do-not-contact query failed:", (byEmail.error ?? byDomain.error)?.message);
    return null;
  }
  return toDncEntries((byEmail.data ?? []) as Array<{ email: string | null }>, (byDomain.data ?? []) as Array<{ domain: string | null }>);
}

export async function fetchExemplars(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  tenantId: string,
  target: ExemplarTarget,
  now: Date = new Date(),
): Promise<Exemplar[]> {
  // Kill switch: off unless EXEMPLARS_ENABLED=1 in Vercel (Pedro's call; the
  // allow-list leak check of PR #17 is what makes turning it on safe).
  if (!exemplarsEnabled()) return [];
  if (target.segment.industry === "other") return [];
  const signal = AbortSignal.timeout(EXEMPLAR_FETCH_BUDGET_MS);
  try {
    const cutoff = new Date(now.getTime() - ATTRIBUTION_WINDOW_DAYS * 86_400_000).toISOString();
    const { data: rows, error } = await supabase
      .from("pitches")
      .select(EXEMPLAR_CANDIDATE_COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("status", "sent")
      .is("parent_pitch_id", null)
      .lte("sent_at", cutoff)
      .eq("prospects.language", target.lang)
      .order("sent_at", { ascending: false })
      .limit(CANDIDATE_SCAN)
      .abortSignal(signal)
      .returns<CandidateRow[]>();
    if (error) {
      console.error("[exemplars] candidates query failed:", error.message);
      return [];
    }
    if (!rows || rows.length === 0) return [];

    const candidates = rows.map(candidateFromRow).filter((c): c is ExemplarCandidate => c !== null);
    const opts = { now, isTestAddress };
    const shortlist = shortlistCandidates(candidates, target, { ...opts, limit: EXEMPLAR_SHORTLIST });
    if (shortlist.length === 0) return [];

    const { data: evRows, error: evErr } = await supabase
      .from("pitch_events")
      .select("pitch_id, event_type, event_at, payload")
      .eq("tenant_id", tenantId)
      .in("pitch_id", shortlist.map((c) => c.pitch_id))
      .in("event_type", OUTCOME_EVENT_TYPES)
      .abortSignal(signal)
      .returns<Array<{ pitch_id: string; event_type: string; event_at: string; payload: OutcomeEvent["payload"] }>>();
    if (evErr) {
      console.error("[exemplars] events query failed:", evErr.message);
      return [];
    }
    const events = new Map<string, OutcomeEvent[]>();
    for (const e of evRows ?? []) {
      const list = events.get(e.pitch_id) ?? [];
      list.push({ type: e.event_type, at: e.event_at, payload: e.payload });
      events.set(e.pitch_id, list);
    }

    // Twice the slots, best first: one dropped by the leak check leaves a runner-up.
    const picked = selectExemplars(
      shortlist.map((c) => ({ ...c, events: events.get(c.pitch_id) ?? [] })),
      target,
      { ...opts, max: MAX_EXEMPLARS * 2 },
    );
    if (picked.length === 0) return [];

    // Fails closed: an exemplar is an enhancement, so an unreadable list means none.
    const emailOf = new Map(shortlist.map((c) => [c.pitch_id, c.recipient_email]));
    const dnc = await dncEntries(supabase, tenantId, picked.map((p) => emailOf.get(p.pitch_id) ?? null), signal);
    if (!dnc) return [];
    const allowed = picked.filter((p) => !onDnc(dnc, emailOf.get(p.pitch_id)));
    if (allowed.length === 0) return [];

    const { data: texts, error: textErr } = await supabase
      .from("pitches")
      .select(
        "id, subject, body_original, body_edited, prospects(company_name, domain, website_url, city), prospect_contacts:contact_id(full_name, email)",
      )
      .eq("tenant_id", tenantId)
      .in("id", allowed.map((p) => p.pitch_id))
      .abortSignal(signal)
      .returns<TextRow[]>();
    if (textErr) {
      console.error("[exemplars] text query failed:", textErr.message);
      return [];
    }
    if (!texts) return [];
    const byId = new Map(texts.map((t) => [t.id, t]));

    const out: Exemplar[] = [];
    let scrubFailed = 0;
    for (const p of allowed) {
      if (out.length >= MAX_EXEMPLARS) break;
      const t = byId.get(p.pitch_id);
      // What a person approved, without the compliance footer body_sent carries.
      const body = t?.body_edited?.trim() || t?.body_original?.trim();
      if (!t || !body || !t.subject?.trim()) continue;
      const exemplar = toExemplar(p, {
        subject: t.subject,
        body,
        company_name: t.prospects?.company_name ?? null,
        domain: t.prospects?.domain ?? null,
        website_url: t.prospects?.website_url ?? null,
        city: t.prospects?.city ?? null,
        recipient_name: t.prospect_contacts?.full_name ?? null,
        recipient_email: t.prospect_contacts?.email ?? null,
      });
      if (exemplar) out.push(exemplar);
      else scrubFailed++;
    }
    if (scrubFailed > 0) console.warn(`[exemplars] scrub_failed: dropped ${scrubFailed} exemplar(s) that still named their prospect`);
    return out;
  } catch (err) {
    console.error("[exemplars] not loaded:", (err as Error).message);
    return [];
  }
}
