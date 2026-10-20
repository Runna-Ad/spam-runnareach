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
//   bounced  → the NDR body is stored, so the dead address is re-parsed with the
//              same parser the poll uses (lib/replies/bounce-parse.ts) and the
//              address goes on the list as "bounced". Only bounces from the last
//              BOUNCE_REPAIR_WINDOW_DAYS: the gap is minutes wide, and a narrow
//              window keeps a reclassified or hand-cleared old bounce from being
//              re-blocked by a parser that has since learned new phrasings.
//
// Idempotent and safe to kill at any point: the DNC row is the only state, it
// is read fresh every run, and each repair is one routine that checks before it
// inserts. A failed repair is simply found again by the next run.
// ─────────────────────────────────────────────────────────────────────────────

import { recordOptOut as realRecordOptOut } from "../compliance/opt-out.ts";
import { extractBouncedRecipient } from "./bounce-parse.ts";
import { isTemporaryDeliveryDelay } from "./classify.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

/**
 * Repairs started per run (opt-outs first, then bounces). Each recordOptOut is
 * ~7 small queries, so 10 is a few seconds at worst; the poll runs every 10
 * minutes, so even a backlog of 100 clears within two hours, while the thread
 * polling and the lead alerts keep their budget.
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
/** Most recent stored replies of each kind read per run (newest first). */
export const REPAIR_SCAN_LIMIT = 1000;
export const BOUNCE_REPAIR_WINDOW_DAYS = 14;
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

type StoredReply = {
  id: string;
  tenant_id: string;
  prospect_id: string | null;
  pitch_id: string | null;
  from_email: string;
  subject: string | null;
  body_text: string | null;
  classified_at: string | null;
};

type Candidate = {
  replyId: string;
  tenantId: string;
  prospectId: string | null;
  /** Lowercased: what recordOptOut writes and what the send-time check reads. */
  email: string;
  /** As stored, so a hand-entered row in the same case is found too (`in` is case-sensitive). */
  rawEmail: string;
};

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
function settled(r: StoredReply, now: number): boolean {
  if (!r.classified_at) return true;
  const t = Date.parse(r.classified_at);
  return Number.isNaN(t) || t <= now - REPAIR_SETTLE_MS;
}

/**
 * The candidates whose address is not on their tenant's list (by address or by
 * domain), one per (tenant, address), in input order. An error when a lookup failed:
 * the caller then writes nothing (an unreadable list must not read as "missing").
 */
async function notOnDnc(
  db: AnySupabase,
  candidates: Candidate[],
): Promise<{ missing: Candidate[] } | { error: string }> {
  const byTenant = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byTenant.get(c.tenantId) ?? [];
    list.push(c);
    byTenant.set(c.tenantId, list);
  }
  const listed = new Set<string>(); // `${tenant}|email:<addr>` / `${tenant}|domain:<d>`
  for (const [tenantId, list] of byTenant) {
    const emails = [...new Set(list.flatMap((c) => [c.email, c.rawEmail.trim()]))];
    const domains = [...new Set(list.map((c) => domainOf(c.email)).filter(Boolean))];
    for (const part of chunks(emails)) {
      const { data, error } = await db.from("do_not_contact_list").select("email").eq("tenant_id", tenantId).in("email", part);
      if (error) return { error: `DNC lookup failed: ${errText(error)}` };
      for (const r of (data ?? []) as Array<{ email: string | null }>) if (r.email) listed.add(`${tenantId}|email:${clean(r.email)}`);
    }
    for (const part of chunks(domains)) {
      const { data, error } = await db.from("do_not_contact_list").select("domain").eq("tenant_id", tenantId).in("domain", part);
      if (error) return { error: `DNC lookup failed: ${errText(error)}` };
      for (const r of (data ?? []) as Array<{ domain: string | null }>) if (r.domain) listed.add(`${tenantId}|domain:${clean(r.domain)}`);
    }
  }
  const seen = new Set<string>();
  const missing: Candidate[] = [];
  for (const c of candidates) {
    const key = `${c.tenantId}|email:${clean(c.email)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (listed.has(key) || listed.has(`${c.tenantId}|domain:${domainOf(c.email)}`)) continue;
    missing.push(c);
  }
  return { missing };
}

/** Stored hard_no replies whose sender never reached the list. */
async function optOutCandidates(db: AnySupabase, now: number): Promise<{ missing: Candidate[] } | { error: string }> {
  const { data, error } = await db
    .from("replies")
    .select("id, tenant_id, prospect_id, pitch_id, from_email, subject, body_text, classified_at")
    .eq("intent", "hard_no")
    .order("received_at", { ascending: false })
    .limit(REPAIR_SCAN_LIMIT);
  if (error) return { error: `hard_no replies read failed: ${errText(error)}` };
  const candidates = ((data ?? []) as StoredReply[])
    .filter((r) => settled(r, now) && r.from_email?.includes("@"))
    .map((r) => ({ replyId: r.id, tenantId: r.tenant_id, prospectId: r.prospect_id, email: clean(r.from_email), rawEmail: r.from_email }));
  return candidates.length === 0 ? { missing: [] } : notOnDnc(db, candidates);
}

/** Recent stored bounces whose NDR names an address that never reached the list. */
async function bounceCandidates(db: AnySupabase, now: number): Promise<{ missing: Candidate[] } | { error: string }> {
  const since = new Date(now - BOUNCE_REPAIR_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("replies")
    .select("id, tenant_id, prospect_id, pitch_id, from_email, subject, body_text, classified_at")
    .eq("intent", "bounced")
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(REPAIR_SCAN_LIMIT);
  if (error) return { error: `bounced replies read failed: ${errText(error)}` };
  // A stored "will retry" notice from before the delay check existed is not a bounce.
  const rows = ((data ?? []) as StoredReply[]).filter(
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
    if (dead) candidates.push({ replyId: r.id, tenantId: r.tenant_id, prospectId: r.prospect_id, email: dead, rawEmail: dead });
  }
  return candidates.length === 0 ? { missing: [] } : notOnDnc(db, candidates);
}

/**
 * Find stored opt-outs (and recent hard bounces) whose address is not on the
 * do-not-contact list and put it there. Never throws. A read error writes
 * nothing for that kind and is reported; the next run tries again.
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
    const found = await optOutCandidates(db, now());
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

  // ── Recent hard bounces whose DNC insert never landed ───────────────────
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
