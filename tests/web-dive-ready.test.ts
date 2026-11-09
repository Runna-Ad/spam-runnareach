/**
 * web-dive: the tick's "draft ready prospects" step (lib/research/web-dive/
 * ready.ts, step first-draft in lib/autopilot/tick.ts). Ready (site look
 * finished, web look done or gave up) → drafts; waiting → skips; past the
 * timeout → drafts with the reason "looks timed out"; the budget floor, the
 * time budget and 2 a tick; failures recorded and tried twice at most. The
 * fake database filters the way Postgres would and rejects unknown columns.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { cronsOf } from "../lib/reports/heartbeat.ts";
import { scheduledRuns } from "../lib/reports/health.ts";
import { firstDraftDecision, LOOK_TIMEOUT_DIVE_RUNS, LOOKS_TIMEOUT_MS, looksTimedOut, siteLookState, WAITING_FOR_LOOKS } from "../lib/research/web-dive/looks.ts";
import { webDiveEnabled } from "../lib/research/web-dive/flag.ts";
import {
  draftReadyProspects,
  FIRST_DRAFT_ACTION,
  FIRST_DRAFT_FAILED_ACTION,
  FIRST_DRAFT_GAVE_UP_ACTION,
  FIRST_DRAFT_MAX_TRIES,
  FIRST_DRAFTS_PER_TICK,
  type FirstDraftDeps,
} from "../lib/research/web-dive/ready.ts";

// Wednesday, inside the send window.
const NOW = new Date("2026-11-11T17:00:00Z");
const H = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const T = "t1";

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA: Record<string, Set<string>> = (() => {
  const out: Record<string, Set<string>> = {};
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const text = readFileSync(new URL(f, dir), "utf8");
    for (const [, table, body] of text.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+) \(([\s\S]*?)\n\);/gi)) {
      const cols = out[table!.toLowerCase()] ?? new Set<string>();
      for (const l of body!.split("\n")) {
        const c = l.trim().match(/^([a-z_][a-z0-9_]*)\s/i)?.[1]?.toLowerCase();
        if (c && !["primary", "unique", "constraint", "foreign", "check"].includes(c)) cols.add(c);
      }
      out[table!.toLowerCase()] = cols;
    }
    for (const [, table, body] of text.matchAll(/alter table (?:if exists )?(?:only )?(?:public\.)?(\w+)([\s\S]*?);/gi)) {
      const cols = out[table!.toLowerCase()];
      if (!cols) continue;
      for (const [, c] of body!.matchAll(/add column (?:if not exists )?(\w+)/gi)) cols.add(c!.toLowerCase());
    }
  }
  return out;
})();

type Row = Record<string, unknown>;
type Res = { data: unknown; error: { message: string } | null };

function fakeDb(tables: Record<string, Row[]>, fail: Record<string, { message: string }> = {}) {
  const get = (r: Row, k: string) => {
    const [c, key] = k.split("->>") as [string, string | undefined];
    if (key === undefined) return r[c];
    const v = (r[c] as Row | null)?.[key];
    return v === undefined || v === null ? null : String(v);
  };
  const check = (table: string, k: string) => {
    const c = k.split("->>")[0]!;
    assert.ok(SCHEMA[table]?.has(c), `${table}.${c} is not a real column`);
  };
  return {
    tables,
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "update" | "insert" = "select";
      let values: Row = {};
      let returning = false;
      let orderBy: { k: string; asc: boolean } | null = null;
      let lim: number | null = null;
      const run = (): Res => {
        if (fail[table]) return { data: null, error: fail[table]! };
        const rows = (tables[table] ??= []);
        if (op === "insert") {
          rows.push({ id: `${table}-${rows.length + 1}`, created_at: NOW.toISOString(), ...values });
          return { data: null, error: null };
        }
        let hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const r of hit) Object.assign(r, values);
          return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
        }
        if (orderBy) {
          const { k, asc } = orderBy;
          hit = [...hit].sort((a, b) => (asc ? 1 : -1) * String(a[k]).localeCompare(String(b[k])));
        }
        if (lim !== null) hit = hit.slice(0, lim);
        return { data: hit.map((r) => ({ ...r })), error: null };
      };
      const b = {
        select(cols?: string) {
          if (op !== "select") returning = true;
          else for (const c of (cols ?? "").split(",").map((x) => x.trim()).filter(Boolean)) check(table, c);
          return b;
        },
        update(v: Row) { op = "update"; values = v; for (const k of Object.keys(v)) check(table, k); return b; },
        insert(v: Row) { op = "insert"; values = v; for (const k of Object.keys(v)) check(table, k); return b; },
        eq(k: string, v: unknown) { check(table, k); filters.push((r) => get(r, k) === v); return b; },
        in(k: string, v: unknown[]) { check(table, k); filters.push((r) => v.includes(get(r, k))); return b; },
        not(k: string, o: string, v: string) {
          check(table, k);
          assert.equal(o, "in");
          const set = new Set(v.replace(/[()]/g, "").split(","));
          filters.push((r) => !set.has(String(get(r, k))));
          return b;
        },
        gt(k: string, v: string) { check(table, k); filters.push((r) => String(get(r, k)) > v); return b; },
        gte(k: string, v: string) { check(table, k); filters.push((r) => String(get(r, k)) >= v); return b; },
        order(k: string, o: { ascending: boolean }) { check(table, k); orderBy = { k, asc: o.ascending }; return b; },
        limit(n: number) { lim = n; return b; },
        abortSignal() { return b; },
        then<A, B>(ok?: ((v: Res) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
          return Promise.resolve(run()).then(ok, bad);
        },
      };
      return b;
    },
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const prospect = (id: string, over: Row = {}): Row => ({
  id, tenant_id: T, status: "match", domain: `${id}.ca`, website_url: `https://${id}.ca`, updated_at: ago(2 * H), pitch_gate_passed: true, ...over,
});
const entered = (id: string, at: string): Row => ({
  id: `a-${id}-${at}`, tenant_id: T, actor_id: null, action: "prospect.scored", entity_type: "prospect", entity_id: id,
  metadata: { kind: WAITING_FOR_LOOKS, score: 80 }, created_at: at,
});
const crawl = (id: string, status: string, at = ago(H)): Row => ({ id: `o-${id}-${Math.random()}`, tenant_id: T, prospect_id: id, status, crawled_at: at });
const dive = (id: string, status: string, at = ago(H)): Row => ({ id: `w-${id}-${Math.random()}`, tenant_id: T, prospect_id: id, status, started_at: at });

type Setup = {
  prospects: Row[];
  audit?: Row[];
  crawls?: Row[];
  dives?: Row[];
  pitches?: Row[];
  fail?: Record<string, { message: string }>;
};

async function step(s: Setup, o: Partial<FirstDraftDeps> & { spent?: number; genFail?: string; onGenerate?: (id: string, db: ReturnType<typeof fakeDb>) => void } = {}) {
  const db = fakeDb(
    {
      prospects: s.prospects,
      audit_log: s.audit ?? s.prospects.map((p) => entered(String(p.id), ago(2 * H))),
      site_observations: s.crawls ?? [],
      web_research: s.dives ?? [],
      pitches: s.pitches ?? [],
    },
    s.fail ?? {},
  );
  const generated: string[] = [];
  const report = await draftReadyProspects({
    db,
    tenantId: T,
    now: NOW,
    deadline: Date.now() + 90_000,
    minBudgetUsd: 0.25,
    // These tests are about both looks; the switched-off dive has its own tests below.
    webDive: true,
    underCap: async () => ({ under: true, spent_today_usd: o.spent ?? 1, cap_usd: 5 }),
    generate: async (id) => {
      generated.push(id);
      o.onGenerate?.(id, db);
      if (o.genFail) return { ok: false, error: o.genFail };
      db.tables.pitches!.push({ id: `pitch-${id}`, tenant_id: T, prospect_id: id, status: "draft" });
      return { ok: true, pitch_id: `pitch-${id}` };
    },
    ...o,
  });
  const audit = (action: string) => db.tables.audit_log!.filter((r) => r.action === action);
  return { report, generated, db, audit, status: (id: string) => db.tables.prospects!.find((p) => p.id === id)?.status };
}

// ── The decision ─────────────────────────────────────────────────────────────

test("siteLookState: finished crawl in 30 days, no site at all, or two abandoned crawls; else waiting", () => {
  const site = { domain: "a.ca", website_url: null };
  const r = (status: string, at = ago(H)) => ({ status, crawled_at: at });
  assert.equal(siteLookState(site, [], NOW), "waiting");
  for (const s of ["ok", "unreachable", "blocked", "not_html", "too_large", "offsite"]) assert.equal(siteLookState(site, [r(s)], NOW), "done", s);
  assert.equal(siteLookState(site, [r("ok", ago(31 * 24 * H))], NOW), "waiting");
  assert.equal(siteLookState(site, [r("pending")], NOW), "waiting");
  assert.equal(siteLookState(site, [r("abandoned")], NOW), "waiting");
  assert.equal(siteLookState(site, [r("abandoned"), r("abandoned", ago(3 * H))], NOW), "done");
  // A pending crawl past 15 minutes was killed (0054 sweeps it to abandoned).
  assert.equal(siteLookState(site, [r("abandoned"), r("pending", ago(16 * 60_000))], NOW), "done");
  assert.equal(siteLookState({ domain: null, website_url: " " }, [], NOW), "done");
});

test("looksTimedOut: 24 h of the dive's schedule; on weekdays exactly 24 h, over a weekend it waits for Monday's runs", () => {
  const t = (iso: string) => new Date(iso).getTime();
  assert.equal(LOOKS_TIMEOUT_MS, 24 * H);
  assert.equal(LOOK_TIMEOUT_DIVE_RUNS, 32);
  // Every 24 h that starts Monday to Thursday holds exactly 32 dive runs.
  for (let start = t("2026-11-09T00:00:00Z"); start < t("2026-11-13T00:00:00Z"); start += 15 * 60_000) {
    assert.equal(scheduledRuns(cronsOf("web-dive"), start, start + 24 * H, 1000), 32, new Date(start).toISOString());
    assert.equal(looksTimedOut(start, start + 24 * H + 60_000), true, new Date(start).toISOString());
    assert.equal(looksTimedOut(start, start + 24 * H), false, "more than 24 h");
  }
  // Friday 23:00 → Sunday noon: no dive ran, not timed out; Monday after the window, timed out.
  const fri = t("2026-11-13T23:00:00Z");
  assert.equal(looksTimedOut(fri, t("2026-11-15T12:00:00Z")), false);
  assert.equal(looksTimedOut(fri, t("2026-11-16T17:00:00Z")), false);
  assert.equal(looksTimedOut(fri, t("2026-11-16T22:50:00Z")), true);
  // The switch to a plain 24 h.
  assert.equal(looksTimedOut(fri, t("2026-11-15T00:00:01Z"), 0), true);
  assert.equal(looksTimedOut(Number.NaN, NOW.getTime()), false);
});

test("firstDraftDecision: site done + web done or gave up → draft; anything waiting → only after the timeout", () => {
  const now = NOW.getTime();
  const fresh = now - 2 * H;
  const old = now - 25 * H;
  assert.deepEqual(firstDraftDecision({ site: "done", web: "done", enteredAtMs: fresh, nowMs: now }), { draft: true, reason: "looks done" });
  assert.deepEqual(firstDraftDecision({ site: "done", web: "gave_up", enteredAtMs: fresh, nowMs: now }), { draft: true, reason: "looks done" });
  assert.deepEqual(firstDraftDecision({ site: "waiting", web: "done", enteredAtMs: fresh, nowMs: now }), { draft: false });
  assert.deepEqual(firstDraftDecision({ site: "done", web: "waiting", enteredAtMs: fresh, nowMs: now }), { draft: false });
  assert.deepEqual(firstDraftDecision({ site: "waiting", web: "waiting", enteredAtMs: old, nowMs: now }), { draft: true, reason: "looks timed out" });
});

// ── The step ─────────────────────────────────────────────────────────────────

test("ready → drafts: generate, status pitched (guarded, from match), an audit row with the reason", async () => {
  const r = await step({ prospects: [prospect("a")], crawls: [crawl("a", "ok")], dives: [dive("a", "empty")] });
  assert.deepEqual(r.generated, ["a"]);
  assert.deepEqual(r.report, { drafted: 1, failed: 0, timedOut: 0, advanced: 0, waiting: null });
  assert.equal(r.status("a"), "pitched");
  const row = r.audit(FIRST_DRAFT_ACTION)[0]!;
  assert.equal(row.entity_type, "prospect");
  assert.equal(row.entity_id, "a");
  assert.deepEqual(row.metadata, { reason: "looks done", site_look: "done", web_look: "done", waited_hours: 2, pitch_id: "pitch-a", status_moved: true });
});

test("ready also when the web look gave up (2 failed dives), or there is no website to read", async () => {
  const gaveUp = await step({ prospects: [prospect("a")], crawls: [crawl("a", "blocked")], dives: [dive("a", "failed"), dive("a", "abandoned", ago(2 * H))] });
  assert.deepEqual(gaveUp.generated, ["a"]);
  const noSite = await step({ prospects: [prospect("b", { domain: null, website_url: null })], dives: [dive("b", "ok")] });
  assert.deepEqual(noSite.generated, ["b"]);
});

test("waiting → skips: no crawl yet, a dive running, one failed dive; nothing is written", async () => {
  const cases: Setup[] = [
    { prospects: [prospect("a")], dives: [dive("a", "ok")] },
    { prospects: [prospect("a")], crawls: [crawl("a", "pending", ago(60_000))], dives: [dive("a", "ok")] },
    { prospects: [prospect("a")], crawls: [crawl("a", "ok")], dives: [dive("a", "pending", ago(60_000))] },
    { prospects: [prospect("a")], crawls: [crawl("a", "ok")], dives: [dive("a", "failed")] },
    { prospects: [prospect("a")], crawls: [crawl("a", "ok")] },
  ];
  for (const s of cases) {
    const r = await step(s);
    assert.deepEqual(r.generated, [], JSON.stringify(s));
    assert.equal(r.status("a"), "match");
    assert.equal(r.audit(FIRST_DRAFT_ACTION).length, 0);
  }
});

test("waiting more than 24 h → drafts anyway with the reason 'looks timed out'", async () => {
  const r = await step({ prospects: [prospect("a")], audit: [entered("a", ago(25 * H))] });
  assert.deepEqual(r.generated, ["a"]);
  assert.equal(r.report.timedOut, 1);
  assert.equal(r.status("a"), "pitched");
  const meta = r.audit(FIRST_DRAFT_ACTION)[0]!.metadata as Row;
  assert.equal(meta.reason, "looks timed out");
  assert.equal(meta.site_look, "waiting");
  assert.equal(meta.web_look, "waiting");
  // 23 h is not past it; the newest entry into match counts (a re-run restarts the clock).
  assert.deepEqual((await step({ prospects: [prospect("a")], audit: [entered("a", ago(23 * H))] })).generated, []);
  assert.deepEqual((await step({ prospects: [prospect("a")], audit: [entered("a", ago(30 * H)), entered("a", ago(3 * H))] })).generated, []);
  // No audit row (it is best-effort): the row's updated_at, which only moves later.
  assert.deepEqual((await step({ prospects: [prospect("a", { updated_at: ago(26 * H) })], audit: [] })).generated, ["a"]);
});

test("budget floor: less than the rewrite minimum left under the cap → no draft, said why", async () => {
  const r = await step({ prospects: [prospect("a")], crawls: [crawl("a", "ok")], dives: [dive("a", "ok")] }, { spent: 4.8 });
  assert.deepEqual(r.generated, []);
  assert.match(r.report.waiting ?? "", /AI budget: \$4\.80 of \$5\.00/);
  const over = await step({ prospects: [prospect("a")], crawls: [crawl("a", "ok")], dives: [dive("a", "ok")] }, { underCap: async () => ({ under: false, spent_today_usd: 5.1, cap_usd: 5 }) });
  assert.deepEqual(over.generated, []);
});

test("time budget: less than 60 s of tick left → no draft; at most 2 a tick, oldest entry first", async () => {
  const late = await step({ prospects: [prospect("a")], crawls: [crawl("a", "ok")], dives: [dive("a", "ok")] }, { deadline: Date.now() + 30_000 });
  assert.deepEqual(late.generated, []);
  assert.match(late.report.waiting ?? "", /tick time budget/);
  const ids = ["a", "b", "c"];
  const r = await step({
    prospects: ids.map((id) => prospect(id)),
    audit: [entered("a", ago(3 * H)), entered("b", ago(5 * H)), entered("c", ago(4 * H))],
    crawls: ids.map((id) => crawl(id, "ok")),
    dives: ids.map((id) => dive(id, "ok")),
  });
  assert.equal(FIRST_DRAFTS_PER_TICK, 2);
  assert.deepEqual(r.generated, ["b", "c"]);
});

test("a failed draft leaves an audit row; after 2 failures the prospect is not tried again", async () => {
  const s: Setup = { prospects: [prospect("a")], crawls: [crawl("a", "ok")], dives: [dive("a", "ok")] };
  const first = await step(s, { genFail: "No usable contact." });
  assert.deepEqual(first.report, { drafted: 0, failed: 1, timedOut: 0, advanced: 0, waiting: null });
  const row = first.audit(FIRST_DRAFT_FAILED_ACTION)[0]!;
  assert.equal(row.entity_id, "a");
  assert.equal((row.metadata as Row).error, "No usable contact.");
  assert.equal(first.status("a"), "match");
  const failRow = (n: number): Row => ({ ...row, id: `f${n}` });
  const second = await step({ ...s, audit: [entered("a", ago(2 * H)), failRow(1)] }, { genFail: "x" });
  assert.deepEqual(second.generated, ["a"]);
  const third = await step({ ...s, audit: [entered("a", ago(2 * H)), failRow(1), failRow(2)] }, { genFail: "x" });
  assert.deepEqual(third.generated, []);
  // A throw is a failure too.
  const thrown = await step(s, { generate: async () => { throw new Error("boom"); } });
  assert.equal(thrown.report.failed, 1);
});

test("prospects whose first draft failed twice stay in match but never crowd a new one out of the scan", async () => {
  const stuck = Array.from({ length: 210 }, (_, i) => prospect(`s${i}`, { updated_at: ago((100 + i) * H) }));
  const fails = stuck.flatMap((p) => [1, 2].map((n) => ({ id: `f-${String(p.id)}-${n}`, tenant_id: T, actor_id: null, action: FIRST_DRAFT_FAILED_ACTION, entity_type: "prospect", entity_id: p.id, metadata: {}, created_at: ago(50 * H) })));
  const r = await step({
    prospects: [...stuck, prospect("new", { updated_at: ago(2 * H) })],
    audit: [...stuck.map((p) => entered(String(p.id), ago(90 * H))), ...fails, entered("new", ago(2 * H))],
    crawls: [crawl("new", "ok")],
    dives: [dive("new", "ok")],
  });
  assert.deepEqual(r.generated, ["new"]);
});

test("a match prospect that already has a pitch (Generate pitch by hand) is moved to pitched, never drafted again", async () => {
  const r = await step({ prospects: [prospect("a"), prospect("b")], pitches: [{ id: "x", tenant_id: T, prospect_id: "a", status: "draft" }], crawls: [crawl("b", "ok")] });
  assert.equal(r.report.advanced, 1);
  assert.equal(r.status("a"), "pitched");
  assert.deepEqual(r.generated, []);
});

test("a person parks the prospect during the draft: the status write's WHERE refuses it", async () => {
  const r = await step(
    { prospects: [prospect("a")], crawls: [crawl("a", "ok")], dives: [dive("a", "ok")] },
    { onGenerate: (id, db) => { db.tables.prospects!.find((p) => p.id === id)!.status = "suppressed"; } },
  );
  assert.equal(r.report.drafted, 1);
  assert.equal(r.status("a"), "suppressed");
  assert.equal((r.audit(FIRST_DRAFT_ACTION)[0]!.metadata as Row).status_moved, false);
});

test("a look that cannot be read is not done: only the timeout drafts, and the step says why (no tick error)", async () => {
  const missing = { message: 'relation "public.web_research" does not exist' };
  const fresh = await step({ prospects: [prospect("a")], crawls: [crawl("a", "ok")], fail: { web_research: missing } });
  assert.deepEqual(fresh.generated, []);
  assert.match(fresh.report.waiting ?? "", /web_research read failed/);
  const old = await step({ prospects: [prospect("a")], audit: [entered("a", ago(25 * H))], fail: { web_research: missing, site_observations: { message: "" } } });
  assert.deepEqual(old.generated, ["a"]);
  assert.match(old.report.waiting ?? "", /site looks not read/);
});

test("a failed read of the prospects, pitches or audit rows is a tick error (throws)", async () => {
  for (const table of ["prospects", "pitches", "audit_log"]) {
    await assert.rejects(step({ prospects: [prospect("a")], fail: { [table]: { message: "" } } }), new RegExp("not read"), table);
  }
});

// ── WEB_DIVE_ENABLED (Pedro 2026-11-09: shipped switched off) ────────────────

test("webDiveEnabled: on only for exactly \"1\"; unset, \"true\", \"0\" or \" 1\" are off", () => {
  assert.equal(webDiveEnabled({ WEB_DIVE_ENABLED: "1" }), true);
  for (const v of [undefined, "", "0", "true", "yes", " 1", "1 "]) assert.equal(webDiveEnabled({ WEB_DIVE_ENABLED: v }), false, String(v));
});

test("dive off: the web look counts as done ('off'), so a finished site look drafts; web_research is never read", async () => {
  const off = await step(
    { prospects: [prospect("a")], crawls: [crawl("a", "ok")], fail: { web_research: { message: "should not be read" } } },
    { webDive: false },
  );
  assert.deepEqual(off.generated, ["a"]);
  assert.equal(off.report.waiting, null, "no web_research read, so no read error");
  assert.deepEqual((off.audit(FIRST_DRAFT_ACTION)[0]!.metadata as Row).web_look, "off");
  assert.equal((off.audit(FIRST_DRAFT_ACTION)[0]!.metadata as Row).reason, "looks done");
  // The site look still counts: no crawl yet → waits (until the timeout).
  const noCrawl = await step({ prospects: [prospect("a")] }, { webDive: false });
  assert.deepEqual(noCrawl.generated, []);
  const timedOut = await step({ prospects: [prospect("a")], audit: [entered("a", ago(25 * H))] }, { webDive: false });
  assert.deepEqual(timedOut.generated, ["a"]);
  // A dive running or failed does not hold the draft when the dive is off.
  const pending = await step({ prospects: [prospect("a")], crawls: [crawl("a", "ok")], dives: [dive("a", "pending", ago(60_000))] }, { webDive: false });
  assert.deepEqual(pending.generated, ["a"]);
  // Dive on (today's behaviour): the same prospect waits for the dive.
  const on = await step({ prospects: [prospect("a")], crawls: [crawl("a", "ok")] }, { webDive: true });
  assert.deepEqual(on.generated, []);
});

test("dive off by default: no WEB_DIVE_ENABLED in the environment means the web look is off", async () => {
  const saved = process.env.WEB_DIVE_ENABLED;
  try {
    delete process.env.WEB_DIVE_ENABLED;
    const r = await step({ prospects: [prospect("a")], crawls: [crawl("a", "ok")] }, { webDive: undefined });
    assert.deepEqual(r.generated, ["a"]);
    process.env.WEB_DIVE_ENABLED = "1";
    const on = await step({ prospects: [prospect("a")], crawls: [crawl("a", "ok")] }, { webDive: undefined });
    assert.deepEqual(on.generated, []);
  } finally {
    if (saved === undefined) delete process.env.WEB_DIVE_ENABLED;
    else process.env.WEB_DIVE_ENABLED = saved;
  }
});

test("gave up: the last failed try writes ONE gave-up row; the prospect stays in match and is not tried again", async () => {
  const s: Setup = { prospects: [prospect("a")], crawls: [crawl("a", "ok")], dives: [dive("a", "ok")] };
  const first = await step(s, { genFail: "No usable contact." });
  assert.equal(first.audit(FIRST_DRAFT_GAVE_UP_ACTION).length, 0, "one try left");
  const failRow = { ...first.audit(FIRST_DRAFT_FAILED_ACTION)[0]!, id: "f1" };
  const second = await step({ ...s, audit: [entered("a", ago(2 * H)), failRow] }, { genFail: "No usable contact." });
  const gaveUp = second.audit(FIRST_DRAFT_GAVE_UP_ACTION);
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0]!.entity_id, "a");
  assert.equal((gaveUp[0]!.metadata as Row).tries, FIRST_DRAFT_MAX_TRIES);
  assert.equal(second.status("a"), "match", "still visible as Waiting for checks");
  const third = await step({ ...s, audit: [entered("a", ago(2 * H)), failRow, { ...failRow, id: "f2" }, gaveUp[0]!] }, { genFail: "x" });
  assert.deepEqual(third.generated, []);
  assert.equal(third.audit(FIRST_DRAFT_GAVE_UP_ACTION).length, 1, "never a second gave-up row");
});

test("tick source: one first-draft step; with the autopilot off it runs before the early return, else after scheduling and before the re-drafts and learners", () => {
  const src = readFileSync(new URL("../lib/autopilot/tick.ts", import.meta.url), "utf8");
  const at = (s: string, from = 0) => {
    const i = src.indexOf(s, from);
    assert.ok(i > 0, s);
    return i;
  };
  const def = at('"first-draft"');
  assert.equal(src.indexOf('"first-draft"', def + 1), -1, "defined once");
  const body = src.slice(def, at("if (!s || safetyOnly(s)) {", def));
  assert.match(body, /minBudgetUsd: REWRITE_MIN_BUDGET_USD/);
  assert.match(body, /generate: \(prospectId\) => generatePitchWith\(actor, prospectId\)/);
  assert.match(body, /underCap: isUnderDailyCap/);
  // Autopilot off: drafted before the return (a draft never sends by itself).
  const early = at("if (!s || safetyOnly(s)) {", def);
  const inOff = at("if (s) report.firstDrafts = await firstDrafts();", early);
  assert.ok(inOff < at("return report;", early));
  // Autopilot on: after scheduling, before the re-drafts and the learners.
  const onPath = at("report.firstDrafts = await firstDrafts();", inOff + 10);
  assert.ok(at('step("schedule"') < onPath);
  assert.ok(onPath < at('step("redraft"'));
  assert.ok(onPath < at('step("learn"'));
});
