/**
 * presend-learning (decision 12): AI-written guidance is hands-off, protected
 * by a pre-send guardrail that retires a guidance challenger whose drafts are
 * thrown away for their writing clearly more often than the champion's.
 * Clicks on tracked links count as a small, non-decisive positive.
 *
 * The reasons the guardrail reads are built here by the code that writes them
 * (governor laneFor + heldAction), with the real WRITER_FIXABLE list, so a
 * change to those strings breaks this test, not the guardrail in silence.
 *
 * learn.ts (presendReview, groupRejectionReasons) is loaded through the same
 * loader hook as tests/learning-review-backoff.test.ts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { heldAction, HELD_BY_PERSON, laneFor, type LaneInput } from "../lib/autopilot/governor.ts";
import { sampleBeta, seededRng } from "../lib/learning/bandit.ts";
import { armStats, funnelForProspect } from "../lib/learning/outcomes.ts";
import {
  heldForWriting,
  PRESEND_MIN_DRAFTS,
  PRESEND_REASON,
  PRESEND_RETIRE_AT,
  presendGuardrail,
  presendStats,
  probabilityWorse,
  type HeldCount,
  type PresendDraft,
} from "../lib/learning/presend.ts";
import { ATTRIBUTION_WINDOW_DAYS, CLICK_VALUE, OUTCOME_EVENT_TYPES, scoreOutcome, type OutcomeEvent } from "../lib/learning/reward.ts";
import { MIN_EXEMPLAR_SCORE, qualifiesAsExemplar, type ExemplarCandidateWithEvents } from "../lib/pitches/exemplars.ts";
import { WRITER_FIXABLE } from "../lib/pitches/review.ts";

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
const { presendReview, groupRejectionReasons, describePresend } = await import("../lib/autopilot/learn.ts");

const DAY = 86_400_000;
const T0 = new Date("2026-10-22T15:00:00Z");
const ago = (days: number) => new Date(T0.getTime() - days * DAY).toISOString();

// ── Reasons, as the autopilot writes them ────────────────────────────────────

const CLEAN: LaneInput = {
  gate: { pass: true, failures: [] },
  critic: { pass: true, score: 0.9 },
  verify: "send",
  recipientSelectedBy: "scraper",
  path: "claude",
};

/** The auto_rejected_reason tick.ts dropDraft writes for this draft, or null when it is not dropped. */
function dropReason(input: Partial<LaneInput>, isRewrite: boolean): string | null {
  const { lane, reasons } = laneFor({ ...CLEAN, ...input });
  const next = heldAction({ lane, reasons, isRewrite, editedByPerson: false }, WRITER_FIXABLE);
  return next.action === "drop" ? next.why : null;
}

test("presend: the clean fixture really is an AUTO draft (so each case below changes one thing)", () => {
  assert.deepEqual(laneFor(CLEAN), { lane: "auto", reasons: [] });
});

test("presend: writing reasons after one rewrite count against the arm", () => {
  const cases: Array<Partial<LaneInput>> = [
    { critic: { pass: false, score: 0.4 } },
    { critic: { pass: true, score: 0.6 } },
    { gate: { pass: false, failures: [{ code: "em_dash", severity: "review" }] } },
    { gate: { pass: false, failures: [{ code: "banned_jargon", severity: "review" }] }, critic: { pass: false, score: 0.3 } },
  ];
  for (const c of cases) {
    const why = dropReason(c, true);
    assert.ok(why, JSON.stringify(c));
    assert.equal(heldForWriting(why, WRITER_FIXABLE), true, why);
  }
  // The prod reason, verbatim.
  assert.equal(heldForWriting("still held after one rewrite: AI review flagged issues", WRITER_FIXABLE), true);
});

test("presend: verifier, address, domain/company, template and probation reasons never count", () => {
  const cases: Array<[string, Partial<LaneInput>, boolean]> = [
    ["verifier unsure", { verify: "review" }, false],
    ["verifier unsure + writing", { verify: "review", critic: { pass: false, score: 0.2 } }, true],
    ["verifier drop", { verify: "drop" }, false],
    ["untrusted source", { recipientSelectedBy: "guess" }, false],
    ["domain unsure", { gate: { pass: false, failures: [{ code: "domain_ownership_unsure", severity: "review" }] } }, false],
    ["company unverified", { gate: { pass: false, failures: [{ code: "company_name_unverified", severity: "review" }] } }, false],
    ["no usable address", { gate: { pass: false, failures: [{ code: "unusable_email", severity: "block" }] } }, false],
    ["template", { path: "template" }, true],
    ["template + writing", { path: "template", critic: { pass: false, score: 0.2 } }, true],
    ["probation", { segmentOnProbation: true }, false],
    ["probation + writing", { segmentOnProbation: true, critic: { pass: false, score: 0.2 } }, true],
    ["AI review did not run", { critic: null }, true],
  ];
  for (const [name, input, isRewrite] of cases) {
    const why = dropReason(input, isRewrite);
    assert.ok(why, `${name}: should be dropped`);
    assert.equal(heldForWriting(why, WRITER_FIXABLE), false, `${name}: ${why}`);
  }
  // The prod reason, verbatim; and the other writers of auto_rejected_reason.
  for (const why of [
    "a rewrite can't fix: verifier unsure about the address",
    "rewrite failed: Claude unavailable",
    `${HELD_BY_PERSON} from the digest link`,
    "on the do-not-contact list",
    "",
    null,
    "still held after one rewrite: ",
  ]) {
    assert.equal(heldForWriting(why, WRITER_FIXABLE), false, String(why));
  }
});

// ── Counting drafts per guidance arm ─────────────────────────────────────────

const draft = (guidance: string | null, status: string, reason: string | null = null, evidence = "benchmark"): PresendDraft => ({
  arms: guidance === null ? undefined : { "writer.evidence": evidence, "writer.guidance": guidance },
  status,
  auto_rejected_reason: reason,
});
const WRITING = "still held after one rewrite: AI review flagged issues";
const VERIFIER = "a rewrite can't fix: verifier unsure about the address";

test("presend: stats count Claude drafts per guidance arm, held only for writing", () => {
  const stats = presendStats(
    [
      draft("g1", "auto_rejected", WRITING),
      draft("g1", "auto_rejected", VERIFIER),
      draft("g1", "sent"),
      draft("g1", "draft"),
      draft("g1", "reviewer_rejected", null),
      draft("g1", "auto_rejected", WRITING, "no_benchmark"),
      draft(null, "auto_rejected", "still held after one rewrite: written by a template (templates never go automatically)"),
      draft(null, "auto_rejected", WRITING),
    ],
    WRITER_FIXABLE,
  );
  // The no_benchmark draft carries g1 too and counts; templates (no arms) do not exist here.
  assert.deepEqual(Object.fromEntries(stats), { g1: { drafts: 6, held: 2 } });
});

// ── The decision ─────────────────────────────────────────────────────────────

const ARMS = [
  { key: "none", status: "champion" },
  { key: "g1", status: "challenger" },
];
const decide = (challenger: HeldCount, champion: HeldCount, arms = ARMS) =>
  presendGuardrail(arms, new Map([["none", champion], ["g1", challenger]]));

test("presend: constants are the brief's", () => {
  assert.equal(PRESEND_MIN_DRAFTS, 12);
  assert.equal(PRESEND_RETIRE_AT, 0.9);
});

test("presend: probabilityWorse is exact (matches a seeded Monte Carlo) and symmetric", () => {
  const rng = seededRng(42);
  const pairs: Array<[HeldCount, HeldCount]> = [
    [{ drafts: 12, held: 7 }, { drafts: 22, held: 11 }],
    [{ drafts: 16, held: 8 }, { drafts: 12, held: 3 }],
    [{ drafts: 40, held: 5 }, { drafts: 25, held: 10 }],
  ];
  for (const [a, b] of pairs) {
    let wins = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      if (sampleBeta(1 + a.held, 1 + a.drafts - a.held, rng) > sampleBeta(1 + b.held, 1 + b.drafts - b.held, rng)) wins++;
    }
    assert.ok(Math.abs(probabilityWorse(a, b) - wins / n) < 0.006, `${JSON.stringify([a, b])}: ${probabilityWorse(a, b)} vs ${wins / n}`);
    assert.ok(Math.abs(probabilityWorse(a, b) + probabilityWorse(b, a) - 1) < 1e-9);
  }
  assert.ok(Math.abs(probabilityWorse({ drafts: 12, held: 6 }, { drafts: 12, held: 6 }) - 0.5) < 1e-9);
});

test("presend: 11 drafts decide nothing, 12 can retire (challenger and champion side)", () => {
  // Every draft held vs almost none: only the count can stop it.
  assert.deepEqual(decide({ drafts: 11, held: 11 }, { drafts: 30, held: 1 }), []);
  assert.equal(decide({ drafts: 12, held: 12 }, { drafts: 30, held: 1 }).length, 1);
  assert.deepEqual(decide({ drafts: 30, held: 30 }, { drafts: 11, held: 0 }), []);
  assert.equal(decide({ drafts: 30, held: 30 }, { drafts: 12, held: 0 }).length, 1);
});

test("presend: P just under 0.9 keeps the arm, just over retires it", () => {
  const under = { challenger: { drafts: 12, held: 5 }, champion: { drafts: 12, held: 2 } };
  const over = { challenger: { drafts: 16, held: 8 }, champion: { drafts: 12, held: 3 } };
  const pUnder = probabilityWorse(under.challenger, under.champion);
  const pOver = probabilityWorse(over.challenger, over.champion);
  assert.ok(pUnder > 0.895 && pUnder < 0.9, String(pUnder));
  assert.ok(pOver >= 0.9 && pOver < 0.905, String(pOver));
  assert.deepEqual(decide(under.challenger, under.champion), []);
  const [r] = decide(over.challenger, over.champion);
  assert.equal(r?.key, "g1");
  assert.equal(r?.reason, PRESEND_REASON);
  assert.deepEqual(r?.challenger, { drafts: 16, held: 8, rate: 0.5 });
  assert.deepEqual(r?.champion, { key: "none", drafts: 12, held: 3, rate: 0.25 });
});

test("presend: prod 2026-10-22 numbers retire nothing yet", () => {
  // g-2026-10-20-1: 12 drafts, 7 auto_rejected; g-2026-10-20-2: 7 / 5; champion none: 22 / 11.
  // Upper bound: every auto_rejected counted as writing-caused.
  const arms = [
    { key: "none", status: "champion" },
    { key: "g-2026-10-20-1", status: "challenger" },
    { key: "g-2026-10-20-2", status: "challenger" },
  ];
  const stats = new Map<string, HeldCount>([
    ["none", { drafts: 22, held: 11 }],
    ["g-2026-10-20-1", { drafts: 12, held: 7 }],
    ["g-2026-10-20-2", { drafts: 7, held: 5 }],
  ]);
  assert.deepEqual(presendGuardrail(arms, stats), []);
  // g1 is about 67% likely worse: far from 0.9. It would take 9 of 12 held at this champion rate.
  assert.ok(Math.abs(probabilityWorse({ drafts: 12, held: 7 }, { drafts: 22, held: 11 }) - 0.67) < 0.01);
  assert.equal(presendGuardrail(arms, new Map([...stats, ["g-2026-10-20-1", { drafts: 12, held: 9 }]])).length, 1);
  assert.deepEqual(presendGuardrail(arms, new Map([...stats, ["g-2026-10-20-1", { drafts: 12, held: 8 }]])), []);
});

test("presend: the champion is never retired; no champion, nothing; retired arms are left alone", () => {
  // The champion is the worst arm by far: still never retired here.
  const worstChampion = presendGuardrail(
    [
      { key: "none", status: "champion" },
      { key: "g1", status: "challenger" },
    ],
    new Map([
      ["none", { drafts: 40, held: 40 }],
      ["g1", { drafts: 40, held: 0 }],
    ]),
  );
  assert.deepEqual(worstChampion, []);
  assert.deepEqual(decide({ drafts: 40, held: 40 }, { drafts: 40, held: 0 }, [{ key: "g1", status: "challenger" }]), []);
  assert.deepEqual(decide({ drafts: 40, held: 40 }, { drafts: 40, held: 0 }, [{ key: "none", status: "champion" }, { key: "g1", status: "retired" }]), []);
});

// ── presendReview in learn.ts, against a fake db ─────────────────────────────

type Row = Record<string, unknown>;
const TENANT = "11111111-1111-1111-1111-111111111111";
const ARM_COLUMNS = new Set(["tenant_id", "learner", "key", "status", "reward", "trials", "negatives", "config", "origin", "created_at", "updated_at", "retired_at"]);
const PITCH_COLUMNS = new Set(["id", "tenant_id", "parent_pitch_id", "created_at", "decision", "status", "auto_rejected_reason"]);
const INSIGHT_COLUMNS = new Set(["id", "tenant_id", "learner", "kind", "title", "detail", "evidence", "applied", "created_at"]);
const COLUMNS: Record<string, Set<string>> = { learning_arms: ARM_COLUMNS, pitches: PITCH_COLUMNS, learning_insights: INSIGHT_COLUMNS };

/** PostgREST returns at most this many rows per request, whatever the range asks. */
const MAX_ROWS = 1000;

type Hooks = { beforeUpdate?: (table: string) => void };

/**
 * Applies filters, ordering, ranges and the 1000-row cap the way PostgREST
 * would; projects the select list ("alias:col->key" reads a JSON key) and
 * rejects a column the table does not have. Counts reads per table.
 */
function fakeDb(tables: Record<string, Row[]>, hooks: Hooks = {}) {
  const reads: Record<string, number> = {};
  const check = (table: string, cols: string[]) => {
    for (const c of cols) if (!COLUMNS[table]?.has(c)) throw new Error(`${table} has no column ${c}`);
  };
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row | null = null;
    let window: [number, number] = [0, Infinity];
    let projection: Array<{ out: string; col: string; key: string | null }> | null = null;
    const rows = () => (tables[table] ??= []);
    const filter = (col: string, f: (v: unknown) => boolean) => {
      check(table, [col]);
      filters.push((r) => f(r[col]));
      return q;
    };
    const project = (r: Row): Row => {
      if (!projection) return { ...r };
      const o: Row = {};
      for (const p of projection) {
        const v = r[p.col];
        o[p.out] = p.key === null ? v : ((v as Record<string, unknown> | null)?.[p.key] ?? null);
      }
      return o;
    };
    const run = () => {
      if (mode === "insert") {
        check(table, Object.keys(payload!));
        rows().push({ ...payload });
        return { data: null, error: null };
      }
      if (mode === "update") hooks.beforeUpdate?.(table);
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      if (mode === "update") {
        check(table, Object.keys(payload!));
        for (const r of hit) Object.assign(r, payload);
        return { data: hit.map(project), error: null };
      }
      reads[table] = (reads[table] ?? 0) + 1;
      for (const o of [...orders].reverse()) hit.sort((x, y) => (o.asc ? 1 : -1) * (String(x[o.col]) < String(y[o.col]) ? -1 : String(x[o.col]) > String(y[o.col]) ? 1 : 0));
      const [lo, hi] = window;
      return { data: hit.slice(lo, Math.min(hi + 1, lo + MAX_ROWS)).map(project), error: null };
    };
    const q = {
      select(cols: string) {
        projection = cols.split(",").map((c) => {
          const m = c.trim().match(/^(?:(\w+):)?(\w+)(?:->(\w+))?$/);
          if (!m) throw new Error(`fake select can't read "${c}"`);
          check(table, [m[2]!]);
          return { out: m[1] ?? m[2]!, col: m[2]!, key: m[3] ?? null };
        });
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
      is: (c: string, v: unknown) => filter(c, (x) => (x ?? null) === v),
      gte: (c: string, v: unknown) => filter(c, (x) => x != null && String(x) >= String(v)),
      order(col: string, o?: { ascending?: boolean }) {
        check(table, [col]);
        orders.push({ col, asc: o?.ascending ?? true });
        return q;
      },
      range(a: number, b: number) {
        window = [a, b];
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
  return { tables, reads, from };
}

let seq = 0;
const pitch = (guidance: string | null, status: string, reason: string | null, createdDaysAgo = 3, parent: string | null = null): Row => ({
  id: `p${String(++seq).padStart(6, "0")}`,
  tenant_id: TENANT,
  parent_pitch_id: parent,
  created_at: ago(createdDaysAgo),
  decision: guidance === null ? { path: "template" } : { arms: { "writer.evidence": "benchmark", "writer.guidance": guidance } },
  status,
  auto_rejected_reason: reason,
});
const arm = (key: string, status: string): Row => ({ tenant_id: TENANT, learner: "writer.guidance", key, status, reward: 0, trials: 0, negatives: 0, config: {} });
const many = (n: number, f: () => Row) => Array.from({ length: n }, f);

test("presendReview: retires the losing challenger once, logs both rates, leaves the champion", async () => {
  const db = fakeDb({
    learning_arms: [arm("none", "champion"), arm("g-bad", "challenger"), arm("g-ok", "challenger")],
    pitches: [
      ...many(3, () => pitch("none", "auto_rejected", WRITING)),
      ...many(17, () => pitch("none", "sent", null)),
      ...many(10, () => pitch("g-bad", "auto_rejected", WRITING)),
      ...many(4, () => pitch("g-bad", "sent", null)),
      // Not counted: verifier reasons, old drafts, follow-ups, templates.
      ...many(5, () => pitch("g-ok", "auto_rejected", VERIFIER)),
      ...many(8, () => pitch("g-ok", "sent", null)),
      ...many(10, () => pitch("none", "auto_rejected", WRITING, 20)),
      ...many(10, () => pitch("none", "auto_rejected", WRITING, 1, "parent")),
      ...many(10, () => pitch(null, "auto_rejected", WRITING)),
    ],
    learning_insights: [],
  });
  const done = await presendReview(db, TENANT, T0);
  assert.deepEqual(done.map((r) => r.key), ["g-bad"]);
  const status = Object.fromEntries((db.tables.learning_arms ?? []).map((a) => [a.key, a.status]));
  assert.deepEqual(status, { none: "champion", "g-bad": "retired", "g-ok": "challenger" });
  assert.equal(db.tables.learning_arms?.find((a) => a.key === "g-bad")?.retired_at, T0.toISOString());

  const [ins, ...rest] = db.tables.learning_insights ?? [];
  assert.equal(rest.length, 0);
  assert.equal(ins?.learner, "writer.guidance");
  assert.equal(ins?.kind, "retire");
  const ev = ins?.evidence as { action: { reason: string }; challenger: HeldCount; champion: HeldCount & { key: string } };
  assert.equal(ev.action.reason, PRESEND_REASON);
  assert.deepEqual([ev.challenger.held, ev.challenger.drafts], [10, 14]);
  assert.deepEqual([ev.champion.key, ev.champion.held, ev.champion.drafts], ["none", 3, 20]);
  assert.match(String(ins?.title), /10 of 14 drafts .*\(71%\) vs 3 of 20 for the champion "none" \(15%\)/);

  // Next tick: already retired, nothing new.
  assert.deepEqual(await presendReview(db, TENANT, T0), []);
  assert.equal(db.tables.learning_insights?.length, 1);
});

test("presendReview: reads past the 1000-row cap", async () => {
  // 1500 older champion drafts, then the 24 that decide: the newest first, all of them read.
  const db = fakeDb({
    learning_arms: [arm("none", "champion"), arm("g-bad", "challenger")],
    pitches: [
      ...many(1500, () => pitch("none", "sent", null, 5)),
      ...many(12, () => pitch("g-bad", "auto_rejected", WRITING, 1)),
    ],
    learning_insights: [],
  });
  const [r] = await presendReview(db, TENANT, T0);
  assert.equal(db.reads.pitches, 2);
  assert.deepEqual(r?.champion && [r.champion.drafts, r.challenger.drafts], [1500, 12]);
});

test("presendReview: the retire is guarded on status = 'challenger'", async () => {
  // Between the read and the write, the arm stops being a challenger (promoted
  // by settleLearner in another tick): the guarded update matches nothing, so
  // nothing is retired and no insight claims it was.
  const tables = {
    learning_arms: [arm("none", "champion"), arm("g-bad", "challenger")],
    pitches: [...many(20, () => pitch("none", "sent", null)), ...many(12, () => pitch("g-bad", "auto_rejected", WRITING))],
    learning_insights: [] as Row[],
  };
  const db = fakeDb(tables, {
    beforeUpdate: (t) => {
      if (t !== "learning_arms") return;
      const bad = tables.learning_arms.find((a) => a.key === "g-bad")!;
      const none = tables.learning_arms.find((a) => a.key === "none")!;
      bad.status = "champion";
      none.status = "challenger";
    },
  });
  assert.deepEqual(await presendReview(db, TENANT, T0), []);
  assert.equal(tables.learning_arms.find((a) => a.key === "g-bad")?.status, "champion");
  assert.equal(tables.learning_insights.length, 0);
});

test("presendReview: a champion with too few drafts decides nothing", async () => {
  const db = fakeDb({
    learning_arms: [arm("none", "champion"), arm("g-bad", "challenger")],
    pitches: [...many(11, () => pitch("none", "sent", null)), ...many(20, () => pitch("g-bad", "auto_rejected", WRITING))],
    learning_insights: [],
  });
  assert.deepEqual(await presendReview(db, TENANT, T0), []);
  assert.equal(db.tables.learning_arms?.find((a) => a.key === "g-bad")?.status, "challenger");
});

test("presendReview: only drafts of the newest writer prompt count (a prompt change restarts the comparison)", async () => {
  // The challenger's held drafts are on the old prompt; the newest rows are on the new one.
  const v = (r: Row, pv: string) => ({ ...r, decision: { ...(r.decision as Row), prompt_version: pv } });
  const db = fakeDb({
    learning_arms: [arm("none", "champion"), arm("g-bad", "challenger")],
    pitches: [
      ...many(12, () => v(pitch("g-bad", "auto_rejected", WRITING, 5), "pitch-v3.2")),
      ...many(12, () => v(pitch("none", "sent", null, 5), "pitch-v3.2")),
      ...many(12, () => v(pitch("none", "sent", null, 1), "pitch-v3.3")),
      ...many(3, () => v(pitch("g-bad", "sent", null, 1), "pitch-v3.3")),
    ],
    learning_insights: [],
  });
  assert.deepEqual(await presendReview(db, TENANT, T0), []);
  assert.equal(db.tables.learning_arms?.find((a) => a.key === "g-bad")?.status, "challenger");
});

test("describePresend: plain sentence with both rates", () => {
  const [r] = decide({ drafts: 16, held: 8 }, { drafts: 12, held: 3 });
  assert.ok(r);
  assert.equal(
    describePresend(r),
    `writer.guidance: retired "g1": 8 of 16 drafts thrown away for their writing (50%) vs 3 of 12 for the champion "none" (25%), 90% likely worse`,
  );
});

// ── The weekly review's input ────────────────────────────────────────────────

test("groupRejectionReasons: split, counted once per draft, most common first", () => {
  const out = groupRejectionReasons([
    { auto_rejected_reason: "still held after one rewrite: AI review flagged issues" },
    { auto_rejected_reason: "still held after one rewrite: AI review flagged issues; gate: em_dash" },
    { auto_rejected_reason: "a rewrite can't fix: verifier unsure about the address" },
    { auto_rejected_reason: "rewrite failed: Claude unavailable" },
    { auto_rejected_reason: null },
    { auto_rejected_reason: "AI review flagged issues; AI review flagged issues" },
  ]);
  assert.deepEqual(out, [
    { reason: "AI review flagged issues", count: 3 },
    { reason: "gate: em_dash", count: 1 },
    { reason: "no reason recorded", count: 1 },
    { reason: "rewrite failed", count: 1 },
    { reason: "verifier unsure about the address", count: 1 },
  ]);
});

// ── Clicks ───────────────────────────────────────────────────────────────────

const ev = (type: string, daysAgo: number, payload: OutcomeEvent["payload"] = null): OutcomeEvent => ({ type, at: ago(daysAgo), payload });
const click = (daysAgo: number) => ev("click", daysAgo, { code: "abc", step: 0, ua: "Mozilla" } as OutcomeEvent["payload"]);

test("clicks: an outcome event type", () => {
  assert.ok(OUTCOME_EVENT_TYPES.includes("click"));
  assert.equal(CLICK_VALUE, 0.25);
});

const W = { clicks: true } as const;

test("clicks: writer learners only; 0.25, never decisive (pending until the window passes), points once", () => {
  const fresh = scoreOutcome([ev("sent", 3), click(2), click(1)], T0, W);
  assert.equal(fresh.value, 0.25);
  assert.equal(fresh.status, "pending");
  assert.equal(fresh.points, 1);
  assert.deepEqual(fresh.signals, ["click"]);
  assert.equal(fresh.negative, false);

  const settled = scoreOutcome([ev("sent", ATTRIBUTION_WINDOW_DAYS), click(ATTRIBUTION_WINDOW_DAYS - 1)], T0, W);
  assert.equal(settled.status, "settled");
  assert.equal(settled.value, 0.25);
  const almost = scoreOutcome([ev("sent", ATTRIBUTION_WINDOW_DAYS - 1), click(1)], T0, W);
  assert.equal(almost.status, "pending");
});

test("clicks: off by default, exactly as before (scout, ICP, exemplars, hunter-signals)", () => {
  const events = [ev("sent", 20), click(19), click(18)];
  const off = scoreOutcome(events, T0);
  const silent = scoreOutcome([ev("sent", 20)], T0);
  assert.deepEqual(off, silent);
  assert.equal(off.value, 0);
});

test("clicks: armStats with clicks (the writer learners) sees 0.25; funnelForProspect still reads 0", () => {
  const p = { arms: { "writer.guidance": "g1", "writer.evidence": "benchmark" }, events: [ev("sent", 20), click(19)] };
  assert.deepEqual(armStats([p], "writer.guidance", T0, W).get("g1"), { reward: 0.25, trials: 1, negatives: 0 });
  assert.deepEqual(armStats([p], "writer.evidence", T0, W).get("benchmark"), { reward: 0.25, trials: 1, negatives: 0 });
  // Without the option (any other caller), a click is silence.
  assert.deepEqual(armStats([p], "writer.guidance", T0).get("g1"), { reward: 0, trials: 1, negatives: 0 });
  const funnel = funnelForProspect("pitched", [{ gatePass: true, sent: true, events: p.events }], T0);
  assert.equal(funnel.outcomeValue, 0);
});

test("clicks: learn.ts turns clicks on for the writer learners and nowhere else", () => {
  const src = readFileSync(new URL("../lib/autopilot/learn.ts", import.meta.url), "utf8");
  assert.equal((src.match(/clicks: true/g) ?? []).length, 1);
  assert.match(src, /armStats\(inputs, learner, now, \{ clicks: true \}\)/);
  const writerLoop = src.slice(src.indexOf('for (const learner of ["writer.evidence", "writer.guidance"])'));
  assert.ok(writerLoop.indexOf("clicks: true") < writerLoop.indexOf("}\n"), "the option sits inside the writer-learner loop");
  for (const f of ["../lib/learning/scout.ts", "../lib/learning/icp.ts", "../lib/pitches/exemplars.ts", "../app/api/public/hunter-signals/route.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /clicks/, f);
  }
});

test("clicks: never lower or raise a stronger signal", () => {
  assert.equal(scoreOutcome([ev("sent", 3), click(2), ev("audit_scan", 1, { stage: "scan" })], T0, W).value, 0.5);
  assert.equal(scoreOutcome([ev("sent", 3), ev("audit_scan", 1, { stage: "scan" })], T0, W).value, 0.5);
  assert.equal(scoreOutcome([ev("sent", 3), click(2), ev("reply", 1, { intent: "wants_meeting" })], T0, W).value, 1);
  assert.equal(scoreOutcome([ev("sent", 3), click(2), ev("meeting_booked", 1)], T0, W).value, 1);
  // An opt-out after a click is still a negative and still decisive.
  const out = scoreOutcome([ev("sent", 3), click(2), ev("unsubscribe", 1)], T0, W);
  assert.equal(out.negative, true);
  assert.equal(out.status, "settled");
  // A test click teaches nothing; a bounce still nulls the value.
  assert.equal(scoreOutcome([ev("sent", 20), ev("click", 19, { test: true })], T0, W).value, 0);
  assert.equal(scoreOutcome([ev("sent", 3), click(2), ev("bounce", 1)], T0, W).value, null);
});

test("clicks: a pitch with only a click is never an exemplar; a scan still is", () => {
  const candidate = (events: OutcomeEvent[]): ExemplarCandidateWithEvents => ({
    pitch_id: "p1",
    prospect_id: "pr1",
    parent_pitch_id: null,
    status: "sent",
    sent_at: ago(30),
    lang: "en",
    industry: "Law firm",
    market: "CA",
    recipient_email: "owner@firm.ca",
    critic_pass: true,
    gate_overridden: false,
    events,
  });
  assert.ok(CLICK_VALUE < MIN_EXEMPLAR_SCORE);
  assert.equal(qualifiesAsExemplar(candidate([ev("sent", 30), click(29)]), { now: T0 }), null);
  assert.equal(qualifiesAsExemplar(candidate([ev("sent", 30), click(29), click(28), click(27)]), { now: T0 }), null);
  assert.equal(qualifiesAsExemplar(candidate([ev("sent", 30), click(29), ev("audit_scan", 28, { stage: "scan" })]), { now: T0 })?.score, 0.5);
});
