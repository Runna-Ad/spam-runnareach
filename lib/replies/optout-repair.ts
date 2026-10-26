// ─────────────────────────────────────────────────────────────────────────────
// lib/replies/optout-repair.ts
//
// Self-repair for opt-outs (and hard bounces) that were stored but never
// reached do_not_contact_list.
//
// The reply poll stores a reply BEFORE it acts on it, and the next run skips
// every stored gmail_message_id. So a run that stored a "remove me" reply and
// then failed (recordOptOut returned ok:false) or was killed at maxDuration left
// the address off the list for good: no later run classifies that reply again.
// This sweep closes that gap from the stored rows alone:
//
//   hard_no  → recordOptOut (the one opt-out routine) for every stored hard_no
//              reply whose sender is not on the tenant's list by address or by
//              domain. Opt-outs never expire, so every stored one is checked.
//              Only a prospect still in a live status gets the full routine
//              (suppress, stop sequences, `unsubscribe` pitch event). One that is
//              already suppressed/closed, or gone, gets the DNC row and the audit
//              only: an `unsubscribe` event is stamped now() and the autopilot's
//              opt_out_spike breaker counts those over 7 days, so a repair of an
//              old opt-out must not look like a new one.
//   bounced  → the NDR body is stored, so the dead address is re-parsed with the
//              same parser the poll uses (lib/replies/bounce-parse.ts) and the
//              address goes on the list as "bounced". Only bounces STORED in the
//              last BOUNCE_REPAIR_WINDOW_MS: the gap is minutes wide, and a person
//              who removes a bounced row in /compliance (a hard delete) must not
//              see it come back.
//
// "On the list" is the send gate's own predicate (lib/discover/dnc-check.ts):
// the lowercased address or its lowercased domain, exact match. A legacy
// mixed-case row does not block a send, so it does not count here either: the
// repair adds the lowercase twin that does.
//
// Idempotent and safe to kill at any point: the DNC row is the only state, it
// is read fresh every run, and each repair is one routine that checks before it
// inserts. A failed repair is simply found again by the next run.
// ─────────────────────────────────────────────────────────────────────────────

import { recordOptOut as realRecordOptOut } from "../compliance/opt-out.ts";
import { DO_NOT_SEND_STATUSES } from "../prospects/status.ts";
import { extractBouncedRecipient } from "./bounce-parse.ts";
import { isTemporaryDeliveryDelay } from "./classify.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

/**
 * Repairs started per run (opt-outs first, then bounces). Each recordOptOut is
 * ~7 small queries, so 10 is a few seconds at worst; the poll runs every 10
 * minutes in the send window (0053), so even a backlog of 100 clears within its
 * first two hours, while the thread polling and the lead alerts keep their budget.
 */
export const REPAIRS_PER_RUN = 10;
/** No repair is STARTED after this deadline offset; leftovers wait for the next run. */
export const REPAIR_BUDGET_MS = 20_000;
/**
 * A reply stored less than this long ago may still be mid-flight in the run
 * that stored it (maxDuration 120 s). Leaving it alone keeps two writers from
 * racing to the same DNC row and the same audit entry.
 */
export const REPAIR_SETTLE_MS = 5 * 60_000;
/**
 * Most recent stored replies of each kind read per run (newest first). Prod has
 * 2 hard_no replies in four months; past 1000 the oldest stop being re-checked,
 * and those were checked by every run before they fell off.
 */
export const REPAIR_SCAN_LIMIT = 1000;
/**
 * Bounces are repaired only within this long of being stored (classified_at, so
 * a late-imported NDR still qualifies): ~10 sweep attempts after the settle wait
 * inside the send window. Outside it the poll runs after the window and once a
 * day (0053), so a bounce stored by one of those runs gets no repair pass if
 * that run died before the DNC write. Widening this trades against the
 * /compliance hard delete above (open decision, 2026-10-26).
 */
export const BOUNCE_REPAIR_WINDOW_MS = 2 * 60 * 60_000;
/** PostgREST puts `in` lists in the URL; keep each one short. */
const IN_CHUNK = 100;

export type RepairCounts = { repaired: number; failed: number; pending: number };
export type RepairResult = { optOuts: RepairCounts; bounces: RepairCounts; errors: string[] };

export type RepairDeps = {
  /** Injected so tests can count calls; prod passes nothing and gets the real routine. */
  recordOptOut?: typeof realRecordOptOut;
  now?: () => number;
  /** Epoch ms after which no new repair starts. */
  deadline?: number;
};

type HardNoRow = {
  id: string;
  tenant_id: string;
  prospect_id: string | null;
  from_email: string;
  classified_at: string | null;
};

type BounceRow = HardNoRow & { pitch_id: string | null; subject: string | null; body_text: string | null };

type Candidate = {
  replyId: string;
  tenantId: string;
  prospectId: string | null;
  /** Lowercased: what recordOptOut writes and what the send gate reads. */
  email: string;
};

type Found = { missing: Candidate[] } | { error: string };

/** Present-not-truthy: postgrest-js reports an empty-body 5xx as { message: "" }. */
function errText(error: unknown): string {
  const m = (error as { message?: unknown } | null)?.message;
  return typeof m === "string" && m.trim() ? m : "query failed with no error message";
}

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += IN_CHUNK) out.push(xs.slice(i, i + IN_CHUNK));
  return out;
}

const clean = (email: string) => email.trim().toLowerCase();
const domainOf = (email: string) => clean(email).split("@")[1] ?? "";

/** Settled: stored long enough ago that the run that stored it has ended. */
function settled(r: { classified_at: string | null }, now: number): boolean {
  if (!r.classified_at) return true;
  const t = Date.parse(r.classified_at);
  return Number.isNaN(t) || t <= now - REPAIR_SETTLE_MS;
}

/**
 * The candidates the send gate would NOT block (no lowercase address row, no
 * lowercase domain row on their tenant's list), one per (tenant, address), in
 * input order. An error when a lookup failed: the caller then writes nothing
 * (an unreadable list must not read as "missing").
 */
async function notOnDnc(db: AnySupabase, candidates: Candidate[]): Promise<Found> {
  const byTenant = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byTenant.get(c.tenantId) ?? [];
    list.push(c);
    byTenant.set(c.tenantId, list);
  }
  const listed = new Set<string>(); // `${tenant}|email:<addr>` / `${tenant}|domain:<d>`
  for (const [tenantId, list] of byTenant) {
    const emails = [...new Set(list.map((c) => c.email))];
    const domains = [...new Set(list.map((c) => domainOf(c.email)).filter(Boolean))];
    for (const part of chunks(emails)) {
      const { data, error } = await db.from("do_not_contact_list").select("email").eq("tenant_id", tenantId).in("email", part);
      if (error) return { error: `DNC lookup failed: ${errText(error)}` };
      for (const r of (data ?? []) as Array<{ email: string | null }>) if (r.email) listed.add(`${tenantId}|email:${r.email}`);
    }
    for (const part of chunks(domains)) {
      const { data, error } = await db.from("do_not_contact_list").select("domain").eq("tenant_id", tenantId).in("domain", part);
      if (error) return { error: `DNC lookup failed: ${errText(error)}` };
      for (const r of (data ?? []) as Array<{ domain: string | null }>) if (r.domain) listed.add(`${tenantId}|domain:${r.domain}`);
    }
  }
  const seen = new Set<string>();
  const missing: Candidate[] = [];
  for (const c of candidates) {
    const key = `${c.tenantId}|email:${c.email}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (listed.has(key) || listed.has(`${c.tenantId}|domain:${domainOf(c.email)}`)) continue;
    missing.push(c);
  }
  return { missing };
}

/** Stored hard_no replies whose sender never reached the list. */
async function optOutCandidates(db: AnySupabase, now: number): Promise<Found> {
  const { data, error } = await db
    .from("replies")
    .select("id, tenant_id, prospect_id, from_email, classified_at, intent")
    .eq("intent", "hard_no")
    .order("received_at", { ascending: false })
    .limit(REPAIR_SCAN_LIMIT);
  if (error) return { error: `hard_no replies read failed: ${errText(error)}` };
  const candidates = ((data ?? []) as HardNoRow[])
    .filter((r) => settled(r, now) && r.from_email?.includes("@"))
    .map((r) => ({ replyId: r.id, tenantId: r.tenant_id, prospectId: r.prospect_id, email: clean(r.from_email) }));
  return candidates.length === 0 ? { missing: [] } : notOnDnc(db, candidates);
}

/**
 * Keep the prospect id only where the prospect is still live: the full opt-out
 * (suppress, stop sequences, `unsubscribe` event) is then exactly what the poll
 * would have done minutes ago. Missing or already closed → null (DNC + audit).
 */
async function withLiveProspects(db: AnySupabase, missing: Candidate[]): Promise<Found> {
  const ids = [...new Set(missing.map((c) => c.prospectId).filter((v): v is string => !!v))];
  const status = new Map<string, string>();
  for (const part of chunks(ids)) {
    const { data, error } = await db.from("prospects").select("id, status").in("id", part);
    if (error) return { error: `prospects read failed: ${errText(error)}` };
    for (const p of (data ?? []) as Array<{ id: string; status: string }>) status.set(p.id, p.status);
  }
  return {
    missing: missing.map((c) => {
      const s = c.prospectId ? status.get(c.prospectId) : undefined;
      return { ...c, prospectId: s !== undefined && !DO_NOT_SEND_STATUSES.has(s) ? c.prospectId : null };
    }),
  };
}

/** Bounces stored in the last window whose NDR names an address that never reached the list. */
async function bounceCandidates(db: AnySupabase, now: number): Promise<Found> {
  const since = new Date(now - BOUNCE_REPAIR_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from("replies")
    .select("id, tenant_id, prospect_id, pitch_id, from_email, subject, body_text, classified_at")
    .eq("intent", "bounced")
    .gte("classified_at", since)
    .order("classified_at", { ascending: false })
    .limit(REPAIR_SCAN_LIMIT);
  if (error) return { error: `bounced replies read failed: ${errText(error)}` };
  // A stored "will retry" notice from before the delay check existed is not a bounce.
  const rows = ((data ?? []) as BounceRow[]).filter(
    (r) =>
      settled(r, now) &&
      r.pitch_id &&
      !isTemporaryDeliveryDelay({ subject: r.subject, body_text: r.body_text, from_email: r.from_email }),
  );
  if (rows.length === 0) return { missing: [] };

  // The parser needs the inbox that sent the pitch, to never name ourselves.
  const pitchIds = [...new Set(rows.map((r) => r.pitch_id!))];
  const inboxOfPitch = new Map<string, string | null>();
  for (const part of chunks(pitchIds)) {
    const { data: pitches, error: pErr } = await db.from("pitches").select("id, sender_inbox_id").in("id", part);
    if (pErr) return { error: `pitches read failed: ${errText(pErr)}` };
    for (const p of (pitches ?? []) as Array<{ id: string; sender_inbox_id: string | null }>) inboxOfPitch.set(p.id, p.sender_inbox_id);
  }
  const inboxIds = [...new Set([...inboxOfPitch.values()].filter((v): v is string => !!v))];
  const inboxEmail = new Map<string, string>();
  for (const part of chunks(inboxIds)) {
    const { data: inboxes, error: iErr } = await db.from("sender_inboxes").select("id, email").in("id", part);
    if (iErr) return { error: `sender inboxes read failed: ${errText(iErr)}` };
    for (const i of (inboxes ?? []) as Array<{ id: string; email: string }>) inboxEmail.set(i.id, i.email);
  }

  const candidates: Candidate[] = [];
  for (const r of rows) {
    const inboxId = inboxOfPitch.get(r.pitch_id!);
    const own = inboxId ? inboxEmail.get(inboxId) : undefined;
    // Without the sending inbox the parser could name our own address: skip.
    if (!own) continue;
    const dead = extractBouncedRecipient(r.body_text, own);
    if (dead) candidates.push({ replyId: r.id, tenantId: r.tenant_id, prospectId: r.prospect_id, email: clean(dead) });
  }
  return candidates.length === 0 ? { missing: [] } : notOnDnc(db, candidates);
}

/**
 * Find stored opt-outs (and fresh hard bounces) whose address the send gate
 * would not block and put it on the do-not-contact list. Never throws. A read
 * error writes nothing for that kind and is reported; the next run tries again.
 */
export async function repairMissedOptOuts(db: AnySupabase, deps: RepairDeps = {}): Promise<RepairResult> {
  const recordOptOut = deps.recordOptOut ?? realRecordOptOut;
  const now = deps.now ?? Date.now;
  const deadline = deps.deadline ?? now() + REPAIR_BUDGET_MS;
  const result: RepairResult = {
    optOuts: { repaired: 0, failed: 0, pending: 0 },
    bounces: { repaired: 0, failed: 0, pending: 0 },
    errors: [],
  };
  let started = 0;
  const mayStart = () => started < REPAIRS_PER_RUN && now() < deadline;
  // Out of time before the first read: the next run gets the whole budget.
  if (!mayStart()) return result;

  // ── Opt-outs first: the compliance promise ──────────────────────────────
  try {
    const listed = await optOutCandidates(db, now());
    const found = "error" in listed || listed.missing.length === 0 ? listed : await withLiveProspects(db, listed.missing);
    if ("error" in found) {
      result.errors.push(`opt-out repair: ${found.error}`);
    } else {
      for (const c of found.missing) {
        if (!mayStart()) {
          result.optOuts.pending++;
          continue;
        }
        started++;
        try {
          const r = await recordOptOut(db, {
            tenantId: c.tenantId,
            prospectId: c.prospectId,
            email: c.email,
            source: "reply",
            note: `Repaired by the reply-poll opt-out sweep: reply ${c.replyId} (hard_no) was stored without a do-not-contact entry.`,
          });
          if (r.ok) result.optOuts.repaired++;
          else {
            result.optOuts.failed++;
            result.errors.push(`opt-out repair for reply ${c.replyId} failed: ${r.error}`);
          }
        } catch (err) {
          result.optOuts.failed++;
          result.errors.push(`opt-out repair for reply ${c.replyId} threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    result.errors.push(`opt-out repair threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Fresh hard bounces whose DNC insert never landed ────────────────────
  if (!mayStart()) return result;
  try {
    const found = await bounceCandidates(db, now());
    if ("error" in found) {
      result.errors.push(`bounce repair: ${found.error}`);
    } else {
      for (const c of found.missing) {
        if (!mayStart()) {
          result.bounces.pending++;
          continue;
        }
        started++;
        // Same row the poll's addEmailToDnc writes, but with the error kept.
        const { error } = await db.from("do_not_contact_list").insert({
          tenant_id: c.tenantId,
          entry_type: "bounced",
          email: c.email,
          notes: `Auto-added ${new Date(now()).toISOString().slice(0, 10)}: hard bounce (undeliverable). Repaired by the reply-poll sweep from reply ${c.replyId}.`,
        });
        if (error) {
          result.bounces.failed++;
          result.errors.push(`bounce repair for reply ${c.replyId} failed: ${errText(error)}`);
        } else {
          result.bounces.repaired++;
        }
      }
    }
  } catch (err) {
    result.errors.push(`bounce repair threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}
