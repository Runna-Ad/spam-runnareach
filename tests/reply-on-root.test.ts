/**
 * reply-on-root: every reply, bounce or out-of-office the poll imports is recorded
 * on the conversation's ROOT pitch (the first email), whatever message in the
 * thread it answers. Learners, exemplars and the weekly report read only roots,
 * so a reply filed on a follow-up row was invisible to them.
 *
 * The route is loaded through a loader hook (as in tests/optout-repair.test.ts):
 * every import is stubbed except lib/pitches/events.ts, which writes into a fake
 * Supabase that keeps the rows. The fake answers the route's own reads from fixed
 * tables and records every insert and update with its filters.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

const u = (p: string) => new URL(p, import.meta.url).href;
const ROUTE = u("../app/api/replies/poll/route.ts");
const REAL: Record<string, Record<string, string>> = {
  [ROUTE]: { "@/lib/pitches/events": u("../lib/pitches/events.ts") },
};

function importsOf(url: string): Record<string, string[]> {
  const text = readFileSync(new URL(url), "utf8");
  const out: Record<string, string[]> = {};
  for (const [, names, from] of text.matchAll(/^import \{([^}]*)\} from "([^"]+)";/gm)) {
    out[from!] = names!
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n && !n.startsWith("type "));
  }
  return out;
}
const STUBS = { [ROUTE]: importsOf(ROUTE) };

const hooks = `
const REAL = ${JSON.stringify(REAL)};
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(spec, ctx, next) {
  const parent = ctx.parentURL;
  if (parent in REAL && !spec.startsWith("node:")) {
    if (REAL[parent][spec]) return { url: REAL[parent][spec], shortCircuit: true };
    return { url: "stub:" + encodeURIComponent(parent) + "|" + encodeURIComponent(spec), shortCircuit: true };
  }
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (!url.startsWith("stub:")) return next(url, ctx);
  const [parent, spec] = url.slice(5).split("|").map(decodeURIComponent);
  const names = (STUBS[parent] || {})[spec] || [];
  const src = names.map((n) =>
    "export const " + n + " = Object.hasOwn(globalThis.__stubValues, " + JSON.stringify(n) + ") ? globalThis.__stubValues[" + JSON.stringify(n) + "]" +
    " : (...a) => globalThis.__stubCall(" + JSON.stringify(n) + ", a);").join("\\n");
  return { format: "module", source: src, shortCircuit: true };
}`;
register("data:text/javascript," + encodeURIComponent(hooks));

// ── World ───────────────────────────────────────────────────────────────────

const T = "tenant-1";
const PROSPECT = "prospect-1";
const INBOX = "inbox-1";
const THREAD = "thread-1";
const ROOT = "pitch-root";
const FU1 = "pitch-fu1";
const FU2 = "pitch-fu2";

type Row = Record<string, unknown>;
type Write = { table: string; op: "insert" | "update"; values: Row; filters: string[] };

type PitchRow = { id: string; sent_at: string; parent_pitch_id: string | null };
const pitch = (id: string, sentAt: string, parent: string | null): PitchRow => ({ id, sent_at: sentAt, parent_pitch_id: parent });

/** Newest first, as the route's `.order("sent_at", { ascending: false })` returns them. */
function pitchRows(rows: PitchRow[]): Row[] {
  return [...rows]
    .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
    .map((p) => ({
      ...p,
      tenant_id: T,
      prospect_id: PROSPECT,
      contact_id: null,
      sender_inbox_id: INBOX,
      subject: "Hola",
      gmail_thread_id: THREAD,
    }));
}

function fakeDb(pitches: Row[], opts: { replyInsertError?: { code: string; message: string } } = {}) {
  const writes: Write[] = [];
  const events: Row[] = [];
  let replySeq = 0;
  const from = (table: string) => {
    const filters: string[] = [];
    let op: "select" | "insert" | "update" = "select";
    let values: Row = {};
    const result = (single: boolean) => {
      if (op === "insert" || op === "update") {
        writes.push({ table, op, values, filters: [...filters] });
        if (table === "pitch_events" && op === "insert") events.push(values);
        if (table === "replies" && op === "insert") {
          if (opts.replyInsertError) return { data: null, error: opts.replyInsertError };
          return { data: { id: `reply-${++replySeq}` }, error: null };
        }
        return { data: single ? null : [{ id: PROSPECT }], error: null };
      }
      if (table === "pitches") return { data: pitches, error: null };
      if (table === "prospects")
        return { data: { id: PROSPECT, company_name: "Clínica Sol", language: "es", status: "contacted", reply_attempts: 0 }, error: null };
      if (table === "sender_inboxes")
        return { data: { email: "nils@runna.ca", display_name: "Nils", gmail_refresh_token_encrypted: "enc" }, error: null };
      return { data: single ? null : [], error: null };
    };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "is", "in", "order", "limit", "lt", "lte", "gte", "neq"]) {
      b[m] = (...a: unknown[]) => {
        if (m !== "select") filters.push(`${m}:${a.map((x) => JSON.stringify(x)).join(",")}`);
        return b;
      };
    }
    b.insert = (v: Row) => ((op = "insert"), (values = v), b);
    b.update = (v: Row) => ((op = "update"), (values = v), b);
    b.maybeSingle = () => Promise.resolve(result(true));
    b.single = () => Promise.resolve(result(true));
    b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(result(false)).then(ok, ko);
    return b;
  };
  return { db: { from }, writes, events };
}

type Inbound = { id: string; from: string; body: string; intent: string; delay?: boolean };
const human = (id: string): Inbound => ({ id, from: "dra.ruiz@clinicasol.mx", body: "Sí, mándeme la info.", intent: "wants_info" });
const bounce = (id: string): Inbound => ({ id, from: "mailer-daemon@googlemail.com", body: "Address not found", intent: "bounced" });
const ooo = (id: string): Inbound => ({ id, from: "dra.ruiz@clinicasol.mx", body: "Fuera de la oficina", intent: "auto_reply" });
const delay = (id: string): Inbound => ({ ...bounce(id), body: "Delivery delayed, will retry", delay: true });

async function poll(pitches: Row[], inbound: Inbound[], opts: Parameters<typeof fakeDb>[1] = {}) {
  const fake = fakeDb(pitches, opts);
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const byBody = new Map(inbound.map((i) => [i.body, i]));
  const g = globalThis as unknown as { __stubValues: Record<string, unknown>; __stubCall: (n: string, a: unknown[]) => unknown };
  g.__stubValues = {
    NextResponse: { json: (body: unknown, init?: unknown) => ({ body, init }) },
  };
  g.__stubCall = (name, args) => {
    calls.push({ name, args });
    switch (name) {
      case "isSchedulerAuthorized":
        return Promise.resolve(true);
      case "createServiceRoleClient":
        return fake.db;
      case "supabaseLeadAlertStore":
        return {};
      case "sendPendingLeadAlerts":
        return Promise.resolve({ sent: 0, failed: [] });
      case "repairMissedOptOuts":
        return Promise.resolve({ optOuts: { repaired: 0, failed: 0, pending: 0 }, bounces: { repaired: 0, failed: 0, pending: 0 }, errors: [] });
      case "getAccessToken":
        return Promise.resolve({ ok: true, accessToken: "tok" });
      case "fetchThreadReplies":
        return Promise.resolve({
          ok: true,
          replies: inbound.map((i, n) => ({
            gmailMessageId: i.id,
            rfcMessageId: `<${i.id}@mail>`,
            fromEmail: i.from,
            fromName: "Dra Ruiz",
            subject: "Re: Hola",
            bodyText: i.body,
            internalDate: Date.parse("2026-10-22T18:00:00Z") + n * 1000,
          })),
        });
      case "isTemporaryDeliveryDelay":
        return byBody.get((args[0] as { body_text: string }).body_text)?.delay === true;
      case "stripQuotedReply":
        return args[0];
      case "isExplicitOptOut":
      case "claudeIsAvailable":
      case "isTestAddress":
        return false;
      case "classifyReplyHeuristic": {
        const i = byBody.get((args[0] as { body_text: string }).body_text);
        return { intent: i?.intent ?? "unclassified", urgency: "warm", sentiment: "positive", reasoning: "test" };
      }
      case "senderIdentity":
        return { firstName: "Nils" };
      case "composeReplyDraftHeuristic":
        return { body: "Gracias", subject: "Re: Hola" };
      case "extractBouncedRecipient":
        return "dead@clinicasol.mx";
      case "addEmailToDnc":
        return Promise.resolve({ ok: true });
      case "protectedStatusFilter":
        return "(booked,won,lost)";
      default:
        throw new Error(`stub ${name} called`);
    }
  };
  const { GET } = (await import(ROUTE)) as {
    GET: (req: unknown) => Promise<{ body: { imported: number; errors: string[] } }>;
  };
  // full=1 reads every thread (no recent-inbound listing to stub).
  const res = await GET({ nextUrl: new URL("https://x/api/replies/poll?full=1"), headers: new Headers() });
  return { ...fake, res: res.body, calls };
}

const repliesInserted = (w: Write[]) => w.filter((x) => x.table === "replies" && x.op === "insert").map((x) => x.values);
const pitchUpdates = (w: Write[]) => w.filter((x) => x.table === "pitches" && x.op === "update");

const FOLLOWED_UP = pitchRows([
  pitch(ROOT, "2026-10-19T15:00:00Z", null),
  pitch(FU1, "2026-10-22T15:00:00Z", ROOT),
]);

// ── Acceptance 1: a thread with a follow-up ────────────────────────────────

test("root + follow-up: a human reply is recorded on the root pitch; the reply row stays on the follow-up", async () => {
  const r = await poll(FOLLOWED_UP, [human("m1")]);
  assert.deepEqual(r.res.errors, []);
  assert.equal(r.res.imported, 1);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.pitch_id, ROOT);
  assert.equal(r.events[0]!.event_type, "reply");
  const payload = r.events[0]!.payload as Record<string, unknown>;
  assert.equal(payload.reply_id, "reply-1");
  assert.equal(payload.answered_pitch_id, FU1);
  assert.equal(payload.intent, "wants_info");
  // replies.pitch_id keeps the thread's newest pitch: the reply composer threads off it.
  assert.equal(repliesInserted(r.writes)[0]!.pitch_id, FU1);
});

test("root + follow-up: a bounce is recorded on the root pitch as 'bounce'", async () => {
  const r = await poll(FOLLOWED_UP, [bounce("m1")]);
  assert.deepEqual(r.res.errors, []);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.pitch_id, ROOT);
  assert.equal(r.events[0]!.event_type, "bounce");
});

test("root + two follow-ups: an out-of-office and a reply both land on the root", async () => {
  const rows = pitchRows([
    pitch(ROOT, "2026-10-12T15:00:00Z", null),
    pitch(FU1, "2026-10-15T15:00:00Z", ROOT),
    pitch(FU2, "2026-10-19T15:00:00Z", ROOT),
  ]);
  const r = await poll(rows, [ooo("m1"), human("m2")]);
  assert.deepEqual(r.res.errors, []);
  assert.deepEqual(
    r.events.map((e) => [e.pitch_id, e.event_type, (e.payload as Row).answered_pitch_id]),
    [
      [ROOT, "reply", FU2],
      [ROOT, "reply", FU2],
    ],
  );
});

test("the root is found from the follow-up's parent even when the root row is not in the poll's result", async () => {
  // The root aged out of the 500 newest sent rows, or left status 'sent'.
  const rows = pitchRows([pitch(FU1, "2026-10-22T15:00:00Z", ROOT)]);
  const r = await poll(rows, [human("m1")]);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.pitch_id, ROOT);
});

test("a chained history (follow-up pointing at a follow-up) still resolves to the thread's parentless row", async () => {
  const rows = pitchRows([
    pitch(ROOT, "2026-10-12T15:00:00Z", null),
    pitch(FU1, "2026-10-15T15:00:00Z", ROOT),
    pitch(FU2, "2026-10-19T15:00:00Z", FU1),
  ]);
  const r = await poll(rows, [human("m1")]);
  assert.equal(r.events[0]!.pitch_id, ROOT);
});

test("schema: every pitches column the poll selects exists, and pitch_events has the columns the event write uses", () => {
  const cols = (table: string) => {
    const out = new Set<string>();
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      const sql = readFileSync(new URL(f, dir), "utf8");
      for (const [, t, body] of sql.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+) \(([\s\S]*?)\n\);/gi)) {
        if (t!.toLowerCase() !== table) continue;
        for (const l of body!.split("\n")) {
          const c = l.trim().match(/^([a-z_][a-z0-9_]*)\s/i)?.[1]?.toLowerCase();
          if (c) out.add(c);
        }
      }
      for (const [, t, body] of sql.matchAll(/alter table (?:if exists )?(?:only )?(?:public\.)?(\w+)([\s\S]*?);/gi)) {
        if (t!.toLowerCase() !== table) continue;
        for (const [, c] of body!.matchAll(/add column (?:if not exists )?(\w+)/gi)) out.add(c!.toLowerCase());
      }
    }
    return out;
  };
  const route = readFileSync(new URL(ROUTE), "utf8");
  const select = route.match(/\.from\("pitches"\)\s*\.select\(\s*"([^"]+)"/)?.[1] ?? "";
  assert.match(select, /parent_pitch_id/);
  const pitches = cols("pitches");
  for (const c of select.split(",").map((x) => x.trim())) assert.ok(pitches.has(c), `pitches.${c} missing`);
  const events = cols("pitch_events");
  for (const c of ["tenant_id", "pitch_id", "event_type", "payload", "event_at"]) assert.ok(events.has(c), `pitch_events.${c} missing`);
});

// ── Acceptance 2 + negative set ─────────────────────────────────────────────

test("root only: the reply is recorded exactly as before, on the root, with the reply row on the root", async () => {
  const r = await poll(pitchRows([pitch(ROOT, "2026-10-19T15:00:00Z", null)]), [human("m1")]);
  assert.deepEqual(r.res.errors, []);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.pitch_id, ROOT);
  assert.equal(r.events[0]!.event_type, "reply");
  assert.equal((r.events[0]!.payload as Row).answered_pitch_id, ROOT);
  assert.equal(repliesInserted(r.writes)[0]!.pitch_id, ROOT);
});

test("a temporary delivery delay still records no event", async () => {
  const r = await poll(FOLLOWED_UP, [delay("m1")]);
  assert.equal(r.res.imported, 1);
  assert.equal(r.events.length, 0);
});

test("23505 (an overlapping run stored the reply) records no event and no side effect", async () => {
  const r = await poll(FOLLOWED_UP, [human("m1")], { replyInsertError: { code: "23505", message: "duplicate key" } });
  assert.deepEqual(r.res.errors, []);
  assert.equal(r.res.imported, 0);
  assert.equal(r.events.length, 0);
  assert.equal(pitchUpdates(r.writes).length, 0);
  assert.equal(r.writes.some((w) => w.table === "prospects"), false);
});

test("side effects on a follow-up thread are unchanged: sequence pause, suppression, DNC and OOO stay keyed on the prospect", async () => {
  const human1 = await poll(FOLLOWED_UP, [human("m1")]);
  const pause = pitchUpdates(human1.writes);
  assert.equal(pause.length, 1);
  assert.ok("sequence_paused_at" in pause[0]!.values);
  assert.ok(pause[0]!.filters.includes(`eq:"prospect_id","${PROSPECT}"`), pause[0]!.filters.join(" "));
  assert.equal(pause[0]!.filters.some((f) => f.startsWith(`eq:"id"`)), false);
  const replied = human1.writes.find((w) => w.table === "prospects" && w.op === "update");
  assert.equal(replied?.values.status, "replied");

  const b = await poll(FOLLOWED_UP, [bounce("m1")]);
  assert.equal(b.calls.filter((c) => c.name === "addEmailToDnc").length, 1);
  assert.equal(b.writes.find((w) => w.table === "prospects" && w.op === "update")?.values.status, "suppressed");
  assert.ok(pitchUpdates(b.writes).every((w) => w.filters.includes(`eq:"prospect_id","${PROSPECT}"`)));

  const o = await poll(FOLLOWED_UP, [ooo("m1")]);
  const postpone = pitchUpdates(o.writes);
  assert.equal(postpone.length, 1);
  assert.ok("next_followup_at" in postpone[0]!.values);
  assert.ok(postpone[0]!.filters.includes(`eq:"prospect_id","${PROSPECT}"`));
});

test("route source: the event write uses the root, the reply row keeps the newest pitch", () => {
  const route = readFileSync(new URL(ROUTE), "utf8");
  assert.match(route, /pitchId: thread\.root_pitch_id,/);
  assert.equal(/pitchId: thread\.pitch_id,/.test(route), false);
  assert.match(route, /pitch_id: thread\.pitch_id,\n\s+prospect_id: thread\.prospect_id,/);
  assert.match(route, /root_pitch_id: p\.parent_pitch_id \?\? p\.id,/);
});
