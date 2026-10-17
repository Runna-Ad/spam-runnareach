// Exemplar memory, the data side: read the candidates, their outcomes, and the
// chosen pitches' text. Selection and scrubbing are pure (./exemplars.ts).
//
// Three small reads, tenant-scoped, each with a timeout:
//   1. recent settled root pitches in the prospect's language (light columns),
//      filtered to the segment in memory (prospect.industry is free text, so
//      SQL cannot match a segment),
//   2. pitch_events for the shortlist (at most EXEMPLAR_SHORTLIST pitches),
//   3. subject + body + who it went to, for the (at most two) chosen.
// Never throws: an exemplar is an enhancement, not a dependency. Any failure
// returns [] and the pitch is written exactly as without exemplars.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isTestAddress } from "../compliance/test-addresses.ts";
import { ATTRIBUTION_WINDOW_DAYS, type OutcomeEvent } from "../learning/reward.ts";
import {
  EXEMPLAR_SHORTLIST,
  selectExemplars,
  shortlistCandidates,
  toExemplar,
  type Exemplar,
  type ExemplarCandidate,
  type ExemplarTarget,
} from "./exemplars.ts";

/** Recent sends scanned for a segment match. */
const CANDIDATE_SCAN = 200;
// Three sequential reads inside the 48s compose budget: worst case 6s, normally ~0.1s.
const QUERY_TIMEOUT_MS = 2_000;

type CandidateRow = {
  id: string;
  prospect_id: string;
  parent_pitch_id: string | null;
  status: string;
  sent_at: string | null;
  critic_pass: boolean | null;
  gate_override: unknown;
  prospects: { industry: string | null; market: string | null; language: string } | null;
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

export async function fetchExemplars(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  tenantId: string,
  target: ExemplarTarget,
  now: Date = new Date(),
): Promise<Exemplar[]> {
  if (target.segment.industry === "other") return [];
  try {
    const cutoff = new Date(now.getTime() - ATTRIBUTION_WINDOW_DAYS * 86_400_000).toISOString();
    const { data: rows, error } = await supabase
      .from("pitches")
      .select(
        "id, prospect_id, parent_pitch_id, status, sent_at, critic_pass:decision->critic->pass, gate_override, prospects!inner(industry, market, language), prospect_contacts:contact_id(email)",
      )
      .eq("tenant_id", tenantId)
      .eq("status", "sent")
      .is("parent_pitch_id", null)
      .lte("sent_at", cutoff)
      .eq("prospects.language", target.lang)
      .order("sent_at", { ascending: false })
      .limit(CANDIDATE_SCAN)
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS))
      .returns<CandidateRow[]>();
    if (error || !rows || rows.length === 0) return [];

    const candidates: ExemplarCandidate[] = rows.map((r) => ({
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
    }));
    const opts = { now, isTestAddress };
    const shortlist = shortlistCandidates(candidates, target, { ...opts, limit: EXEMPLAR_SHORTLIST });
    if (shortlist.length === 0) return [];

    const { data: evRows, error: evErr } = await supabase
      .from("pitch_events")
      .select("pitch_id, event_type, event_at, payload")
      .eq("tenant_id", tenantId)
      .in("pitch_id", shortlist.map((c) => c.pitch_id))
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS))
      .returns<Array<{ pitch_id: string; event_type: string; event_at: string; payload: OutcomeEvent["payload"] }>>();
    if (evErr) return [];
    const events = new Map<string, OutcomeEvent[]>();
    for (const e of evRows ?? []) {
      const list = events.get(e.pitch_id) ?? [];
      list.push({ type: e.event_type, at: e.event_at, payload: e.payload });
      events.set(e.pitch_id, list);
    }

    const picked = selectExemplars(
      shortlist.map((c) => ({ ...c, events: events.get(c.pitch_id) ?? [] })),
      target,
      opts,
    );
    if (picked.length === 0) return [];

    const { data: texts, error: textErr } = await supabase
      .from("pitches")
      .select(
        "id, subject, body_original, body_edited, prospects(company_name, domain, website_url, city), prospect_contacts:contact_id(full_name, email)",
      )
      .eq("tenant_id", tenantId)
      .in("id", picked.map((p) => p.pitch_id))
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS))
      .returns<TextRow[]>();
    if (textErr || !texts) return [];
    const byId = new Map(texts.map((t) => [t.id, t]));

    const out: Exemplar[] = [];
    for (const p of picked) {
      const t = byId.get(p.pitch_id);
      // What a person approved, without the compliance footer body_sent carries.
      const body = t?.body_edited?.trim() || t?.body_original?.trim();
      if (!t || !body || !t.subject?.trim()) continue;
      out.push(
        toExemplar(p, {
          subject: t.subject,
          body,
          company_name: t.prospects?.company_name ?? null,
          domain: t.prospects?.domain ?? null,
          website_url: t.prospects?.website_url ?? null,
          city: t.prospects?.city ?? null,
          recipient_name: t.prospect_contacts?.full_name ?? null,
          recipient_email: t.prospect_contacts?.email ?? null,
        }),
      );
    }
    return out;
  } catch (err) {
    console.warn("[exemplars] not loaded:", (err as Error).message);
    return [];
  }
}
