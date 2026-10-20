/**
 * learning-review-backoff: the weekly AI review pays for at most one attempt a
 * day whatever goes wrong, says why a failure happened, and tolerates the
 * output shapes that used to fail the schema.
 *
 * learn.ts imports "server-only" and "@/" aliases, so a loader hook (as in
 * tests/autopilot-trust-split.test.ts) maps "@/lib/learning/*" to the real pure
 * modules, stubs "server-only" and lib/anthropic, and the paid call is injected.
 * The db is a fake that applies filters the way Postgres would and rejects a
 * learning_insights column the table (0040) does not have.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { z } from "zod";

const u = (p: string) => new URL(p, import.meta.url).href;
const LEARN = u("../lib/autopilot/learn.ts");
const hooks = `
const LEARN = ${JSON.stringify(LEARN)};
const ROOT = ${JSON.stringify(u("../"))};
const STUBS = {
  "server-only": "",
  "@/lib/anthropic/client": "export const ANTHROPIC_DEFAULT_MODEL = 'test-model'; export const claudeIsAvailable = () => true; export const structuredCall = () => { throw new Error('real structuredCall reached'); };",
  "@/lib/anthropic/cost-tracking": "export const isUnderDailyCap = async () => ({ under: true }); export const recordClaudeCall = async () => {};",
};
export async function resolve(spec, ctx, next) {
  if (ctx.parentURL === LEARN) {
    if (spec in STUBS) return { url: "stub:" + encodeURIComponent(spec), shortCircuit: true };
    if (spec.startsWith("@/")) return { url: ROOT + spec.slice(2) + ".ts", shortCircuit: true };
  }
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (!url.startsWith("stub:")) return next(url, ctx);
  return { format: "module", source: STUBS[decodeURIComponent(url.slice(5))], shortCircuit: true };
}`;
register("data:text/javascript," + encodeURIComponent(hooks));

const { weeklyReview, reviewSchema, reviewFailureText, REVIEW_ATTEMPT_LEARNER } = await import("../lib/autopilot/learn.ts");
const { sanitizeGuidance } = await import("../lib/learning/outcomes.ts");

const TENANT = "11111111-1111-1111-1111-111111111111";
const T0 = new Date("2026-10-21T15:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ── Fake Supabase ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const INSIGHT_COLUMNS = new Set(["id", "tenant_id", "learner", "kind", "title", "detail", "evidence", "applied", "created_at"]);
const KINDS = new Set(["promote", "retire", "challenger", "observation", "breaker", "stage", "proposal"]);

const cmp = (a: unknown, b: unknown): number => {
  const ta = Date.parse(String(a));
  const tb = Date.parse(String(b));
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

function fakeDb(tables: Record<string, Row[]>, opts: { failInsert?: boolean; failRowRead?: boolean } = {}) {
  let seq = 0;
  const clock = { now: T0 };
  const checkCols = (table: string, cols: string[]) => {
    if (table !== "learning_insights") return;
    for (const c of cols) if (!INSIGHT_COLUMNS.has(c)) throw new Error(`learning_insights has no column ${c}`);
  };
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" = "select";
    let head = false;
    let order: { col: string; asc: boolean } | null = null;
    let limit = Infinity;
    let single = false;
    let payload: Row | null = null;
    const rows = () => (tables[table] ??= []);
    const filter = (col: string, f: (v: unknown) => boolean) => {
      checkCols(table, [col]);
      filters.push((r) => f(r[col]));
      return q;
    };
    const run = () => {
      if (mode === "insert") {
        if (opts.failInsert && table === "learning_insights") return { data: null, error: { message: "insert failed" } };
        checkCols(table, Object.keys(payload!));
        if (table === "learning_insights" && !KINDS.has(String(payload!.kind))) return { data: null, error: { message: "check violation" } };
        const row = { id: `${table}-${++seq}`, created_at: clock.now.toISOString(), ...payload };
        rows().push(row);
        return { data: single ? { id: row.id } : null, error: null };
      }
      // postgrest-js reports an empty-body 502 as { message: "" }.
      if (opts.failRowRead && mode === "select" && !head && table === "learning_insights") return { data: null, error: { message: "" } };
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      if (mode === "update") {
        checkCols(table, Object.keys(payload!));
        for (const r of hit) Object.assign(r, payload);
        return { data: null, error: null };
      }
      if (order) hit.sort((a, b) => (order!.asc ? 1 : -1) * cmp(a[order!.col], b[order!.col]));
      const data = hit.slice(0, limit);
      return { data: head ? null : data, count: hit.length, error: null };
    };
    const q = {
      select(cols: string, o?: { head?: boolean }) {
        if (mode === "select") checkCols(table, cols.split(",").map((c) => c.trim()));
        head = Boolean(o?.head);
        return q;
      },
      insert(row: Row) {
        mode = "insert";
        payload = row;
        return q;
      },
      update(patch: Row) {
        mode = "update";
        payload = patch;
        return q;
      },
      eq: (c: string, v: unknown) => filter(c, (x) => x === v),
      neq: (c: string, v: unknown) => filter(c, (x) => x !== v),
      is: (c: string, v: unknown) => filter(c, (x) => (x ?? null) === v),
      not: (c: string, _op: string, v: unknown) => filter(c, (x) => (x ?? null) !== v),
      in: (c: string, vs: unknown[]) => filter(c, (x) => vs.includes(x)),
      gte: (c: string, v: unknown) => filter(c, (x) => x != null && cmp(x, v) >= 0),
      order(col: string, o?: { ascending?: boolean }) {
        checkCols(table, [col]);
        order = { col, asc: o?.ascending ?? true };
        return q;
      },
      limit(n: number) {
        limit = n;
        return q;
      },
      single() {
        single = true;
        return q;
      },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        try {
          return Promise.resolve(run()).then(res, rej);
        } catch (e) {
          return Promise.reject(e).then(res, rej);
        }
      },
    };
    return q;
  };
  return { tables, clock, from };
}

/** Ten root emails sent last week: enough to review. */
function seeded(extra: Record<string, Row[]> = {}) {
  const pitches = Array.from({ length: 10 }, (_, i) => ({
    id: `p${i}`,
    tenant_id: TENANT,
    parent_pitch_id: null,
    sent_at: new Date(T0.getTime() - 3 * DAY).toISOString(),
    created_at: new Date(T0.getTime() - 4 * DAY).toISOString(),
    updated_at: new Date(T0.getTime() - 3 * DAY).toISOString(),
    status: "sent",
  }));
  return fakeDb({ pitches, replies: [], learning_arms: [], learning_insights: [], ...extra });
}

const USAGE = { input_tokens: 4624, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0.025 };
type CallResult = { ok: true; data: unknown; usage: typeof USAGE; raw: string; model: string } | { ok: false; error: string; usage: typeof USAGE | null; reason: string };

function deps(answer: () => CallResult) {
  const paid: unknown[] = [];
  const recorded: unknown[] = [];
  return {
    paid,
    recorded,
    deps: {
      call: (async (input: unknown) => {
        paid.push(input);
        return answer();
      }) as never,
      claudeAvailable: () => true,
      underCap: (async () => ({ under: true })) as never,
      record: (async (r: unknown) => {
        recorded.push(r);
      }) as never,
    },
  };
}

const SCHEMA_FAIL: CallResult = { ok: false, error: "Schema validation failed: observations.0.title:Required; guidance.0.why:Required", usage: USAGE, reason: "parse" };
const okWith = (data: unknown): CallResult => ({ ok: true, data: reviewSchema.parse(data), usage: USAGE, raw: "{}", model: "test-model" });

/** One tick of the review, at `at`. */
async function tick(db: ReturnType<typeof fakeDb>, at: Date, d: ReturnType<typeof deps>) {
  db.clock.now = at;
  return weeklyReview(db, TENANT, at, d.deps);
}

// ── One paid attempt a day ───────────────────────────────────────────────────

test("a failing call is paid once, then 95 more ticks in the next 24 h pay nothing; after 24 h a second attempt", async () => {
  const db = seeded();
  const d = deps(() => SCHEMA_FAIL);
  const first = await tick(db, T0, d);
  assert.equal(d.paid.length, 1);
  assert.equal(first.ran, false);
  for (let i = 1; i <= 95; i++) {
    const r = await tick(db, new Date(T0.getTime() + i * 15 * MIN), d);
    assert.match(r.reason, /attempted in the last 24 h/);
  }
  assert.equal(d.paid.length, 1, "still one paid call after 96 ticks");
  assert.equal(d.recorded.length, 1, "the one call's cost is recorded");
  await tick(db, new Date(T0.getTime() + DAY + MIN), d);
  assert.equal(d.paid.length, 2);
});

test("the failure says why: reason and error text on the attempt row and in the tick report", async () => {
  const db = seeded();
  const d = deps(() => SCHEMA_FAIL);
  const r = await tick(db, T0, d);
  assert.equal(r.reason, "review call failed (parse): Schema validation failed: observations.0.title:Required; guidance.0.why:Required");
  const rows = db.tables.learning_insights!.filter((x) => x.learner === REVIEW_ATTEMPT_LEARNER);
  assert.equal(rows.length, 1);
  assert.match(String(rows[0]!.title), /^Weekly AI review failed \(parse\); next try after 2026-10-22 15:00 UTC$/);
  assert.equal(rows[0]!.detail, "Schema validation failed: observations.0.title:Required; guidance.0.why:Required");
  assert.deepEqual(rows[0]!.evidence, { reason: "parse" });
  assert.equal(db.tables.learning_insights!.filter((x) => x.learner === "review").length, 0, "a failure is not a review");
});

test("a failure's text keeps no model output (it can quote prospect replies)", () => {
  const err = `JSON parse failed: Unexpected token 'H', "Here is th"... is not valid JSON. Raw: Here is the review: Maria from Clinica Sol said the audit is too long`;
  const t = reviewFailureText(err);
  assert.equal(t, `JSON parse failed: Unexpected token 'H', "…" is not valid JSON`);
  assert.ok(!t.includes("Maria"));
  assert.ok(reviewFailureText("x".repeat(1000)).length <= 300);
  const api = `400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: too large"}}`;
  assert.equal(reviewFailureText(api), api, "an API error keeps its message");
});

test("a timeout, a call that never returns usage, also counts: one attempt a day whatever the reason", async () => {
  const db = seeded();
  const d = deps(() => ({ ok: false, error: "Request timed out.", usage: null, reason: "timeout" }));
  await tick(db, T0, d);
  await tick(db, new Date(T0.getTime() + 15 * MIN), d);
  await tick(db, new Date(T0.getTime() + 23 * HOUR), d);
  assert.equal(d.paid.length, 1);
  assert.equal(d.recorded.length, 0);
  assert.match(String(db.tables.learning_insights!.find((x) => x.learner === REVIEW_ATTEMPT_LEARNER)!.title), /failed \(timeout\)/);
});

test("the attempt is marked before the call: a run killed mid-call still blocks the next tick", async () => {
  const db = seeded();
  const d = deps(() => {
    throw new Error("function killed at maxDuration");
  });
  await assert.rejects(tick(db, T0, d));
  await tick(db, new Date(T0.getTime() + 15 * MIN), d);
  assert.equal(d.paid.length, 1);
});

test("no mark, no paid call: if the attempt row cannot be written the review is skipped", async () => {
  const db = seeded();
  const failing = fakeDb(db.tables, { failInsert: true });
  const d = deps(() => SCHEMA_FAIL);
  const r = await tick(failing, T0, d);
  assert.equal(d.paid.length, 0);
  assert.match(r.reason, /could not record the review attempt/);
});

test("an unreadable attempt log (empty-body 502) fails closed: no paid call", async () => {
  const db = seeded();
  const unreadable = fakeDb(db.tables, { failRowRead: true });
  const d = deps(() => SCHEMA_FAIL);
  const r = await tick(unreadable, T0, d);
  assert.equal(d.paid.length, 0);
  assert.equal(r.reason, "could not read the last review attempt");
});

// ── One successful review a week ─────────────────────────────────────────────

const GOOD = {
  observations: [{ title: "Replies ask about the audit's cost", evidence: "4 of 6 replies asked what the audit costs" }],
  guidance: [{ text: "Say plainly that the audit is free in the first line.", why: "Replies keep asking about cost" }],
};

test("a success writes the same insights and arm as before, then no attempt for 7 days", async () => {
  const db = seeded();
  const d = deps(() => okWith(GOOD));
  const r = await tick(db, T0, d);
  assert.deepEqual(r, { ran: true, reason: "ok", guidance: ["Say plainly that the audit is free in the first line."] });
  const review = db.tables.learning_insights!.filter((x) => x.learner === "review").map((x) => [x.kind, x.title, x.detail]);
  assert.deepEqual(review, [
    ["observation", "Replies ask about the audit's cost", "4 of 6 replies asked what the audit costs"],
    ["challenger", "Testing new guidance: Say plainly that the audit is free in the first line.", "Replies keep asking about cost"],
  ]);
  assert.deepEqual(
    db.tables.learning_arms!.map((a) => [a.learner, a.key, a.status, a.config]),
    [["writer.guidance", "g-2026-10-21-1", "challenger", { text: "Say plainly that the audit is free in the first line.", why: "Replies keep asking about cost" }]],
  );
  assert.equal(db.tables.learning_insights!.find((x) => x.learner === REVIEW_ATTEMPT_LEARNER)!.title, "Weekly AI review ran");
  for (let t = T0.getTime() + 15 * MIN; t < T0.getTime() + 7 * DAY; t += 15 * MIN) {
    const r2 = await tick(db, new Date(t), d);
    assert.equal(r2.reason, "reviewed this week");
  }
  assert.equal(d.paid.length, 1);
  await tick(db, new Date(T0.getTime() + 7 * DAY + MIN), d);
  assert.equal(d.paid.length, 2);
});

test("the conductor's stop-gap row alone skips the review, and writes nothing", async () => {
  const db = seeded({
    learning_insights: [{ id: "stop", tenant_id: TENANT, learner: "review", kind: "observation", title: "Weekly review paused by hand: the review call failed every tick", created_at: "2026-10-20T15:25:00Z" }],
  });
  const d = deps(() => SCHEMA_FAIL);
  const r = await tick(db, T0, d);
  assert.equal(r.reason, "reviewed this week");
  assert.equal(d.paid.length, 0);
  assert.equal(db.tables.learning_insights!.length, 1);
});

test("the old gates still hold: under 10 root sends, Claude off, or the cap reached → no call, no attempt row", async () => {
  const thin = fakeDb({ pitches: [], learning_insights: [] });
  const d = deps(() => SCHEMA_FAIL);
  assert.match((await tick(thin, T0, d)).reason, /only 0 emails sent/);
  const off = seeded();
  assert.equal((await weeklyReview(off, TENANT, T0, { ...d.deps, claudeAvailable: () => false })).reason, "Claude unavailable");
  const capped = seeded();
  assert.equal((await weeklyReview(capped, TENANT, T0, { ...d.deps, underCap: (async () => ({ under: false })) as never })).reason, "daily AI cap reached");
  assert.equal(d.paid.length, 0);
  for (const db of [thin, off, capped]) assert.equal(db.tables.learning_insights!.length, 0);
});

// ── Output shapes ────────────────────────────────────────────────────────────

/** The schema before this change, to prove valid output parses the same. */
const OLD = z.object({
  observations: z.array(z.object({ title: z.string().min(5).max(200), evidence: z.string().min(5).max(600) })).max(6).default([]),
  guidance: z.array(z.object({ text: z.string().min(12).max(400), why: z.string().min(5).max(400) })).max(2).default([]),
});

test("output the old schema accepted parses to the same data", () => {
  for (const ok of [GOOD, {}, { observations: [] }, { guidance: GOOD.guidance, extra: 1 }]) {
    const { dropped, ...rest } = reviewSchema.parse(ok);
    assert.deepEqual(rest, OLD.parse(ok));
    assert.equal(dropped, 0);
  }
});

test("800-char evidence and a 450-char guidance text are clipped, not rejected; the guidance check still runs", () => {
  assert.equal(OLD.safeParse({ observations: [{ title: "Long one", evidence: "e".repeat(800) }] }).success, false);
  const out = reviewSchema.parse({
    observations: [{ title: "Long one", evidence: "e".repeat(800) }],
    guidance: [{ text: "Keep the email short and plain. ".repeat(15).slice(0, 450), why: "w".repeat(450) }],
  });
  assert.equal(out.observations[0]!.evidence.length, 600);
  assert.equal(out.guidance[0]!.text.length, 400);
  assert.equal(out.guidance[0]!.why.length, 400);
  const verdict = sanitizeGuidance(out.guidance[0]!.text);
  assert.equal(verdict.ok, false, "over the guidance limit: discarded by sanitizeGuidance, never bypassing it");
});

test("a clipped over-long guidance is logged as discarded, never becomes an arm", async () => {
  const db = seeded();
  const d = deps(() => okWith({ guidance: [{ text: "Open with the prospect's own words about their booking. ".repeat(10), why: "Replies quote their own words" }] }));
  const r = await tick(db, T0, d);
  assert.deepEqual(r.guidance, []);
  assert.equal(db.tables.learning_arms!.length, 0);
  assert.ok(db.tables.learning_insights!.some((x) => x.kind === "proposal" && String(x.title).startsWith("Discarded guidance:")));
});

test("shapes that used to fail and now pass: a wrapper object, alias keys, too many items, one bad item among good ones", () => {
  assert.deepEqual(reviewSchema.parse({ review: GOOD }).guidance, GOOD.guidance);
  const aliased = reviewSchema.parse({
    observations: [{ observation: "Replies ask about cost", evidence: "4 of 6 replies" }],
    guidance: [{ instruction: "Say plainly that the audit is free.", reason: "Cost questions" }],
  });
  assert.deepEqual(aliased.observations, [{ title: "Replies ask about cost", evidence: "4 of 6 replies" }]);
  assert.deepEqual(aliased.guidance, [{ text: "Say plainly that the audit is free.", why: "Cost questions" }]);
  const many = reviewSchema.parse({ observations: Array.from({ length: 9 }, () => GOOD.observations[0]), guidance: [...GOOD.guidance, ...GOOD.guidance, ...GOOD.guidance] });
  assert.equal(many.observations.length, 6);
  assert.equal(many.guidance.length, 2);
  const mixed = reviewSchema.parse({ observations: [GOOD.observations[0], { title: "Hi" }] });
  assert.equal(mixed.observations.length, 1);
  assert.equal(mixed.dropped, 1);
});

test("shapes that still fail: not an object at all", () => {
  assert.equal(reviewSchema.safeParse([GOOD]).success, false);
  assert.equal(reviewSchema.safeParse("no").success, false);
});

test("every item malformed is a failure (counted, explained), not an empty week", async () => {
  const db = seeded();
  const d = deps(() => okWith({ observations: [{ point: "x" }, { point: "y" }], guidance: [{ idea: "z" }] }));
  const r = await tick(db, T0, d);
  assert.equal(r.ran, false);
  assert.equal(r.reason, "review call failed (parse): every item the model returned was malformed (3 dropped)");
  assert.equal(db.tables.learning_insights!.filter((x) => x.learner === "review").length, 0, "the week stays open for a real review");
  await tick(db, new Date(T0.getTime() + HOUR), d);
  assert.equal(d.paid.length, 1);
});

test("the prompt states the shape and limits the schema checks", async () => {
  const db = seeded();
  const d = deps(() => SCHEMA_FAIL);
  await tick(db, T0, d);
  const system = (d.paid[0] as { system: string }).system;
  assert.match(system, /"observations": \[\{"title": "\.\.\.", "evidence": "\.\.\."\}\]/);
  assert.match(system, /up to 6 observations \(title under 200 characters, evidence under 600\)/);
  assert.match(system, /text one sentence under 280 characters/);
});
