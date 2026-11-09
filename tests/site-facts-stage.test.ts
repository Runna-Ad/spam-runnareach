/**
 * Brief tasks/briefs/site-facts-writer.md, the loaders: generatePitchWith and
 * rewritePitchWithAngleWith both read the newest ok site observation of THIS
 * tenant's prospect and hand the same site_facts to the writer and the
 * critic; no row or a read error drafts anyway with site_facts []. Drives the
 * real stage, the real loader and the real write → review loop (SDK faked);
 * every other import of pitch-stage.ts is stubbed by a loader hook (same
 * harness as tests/wanted-facts-writer.test.ts).
 *
 * Proven facts (2026-11-09, CrushCamp): the real lib/pitches/proven-facts.ts
 * runs too. Only seen facts reach the writer and the critic, research pains
 * never do (a rewrite's chosen angle keeps its pain, without the evidence),
 * and a first draft with no proven problem or opening is the showcase email.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test, { mock } from "node:test";
import { NOT_REVIEWED_ISSUE, WRITER_FIXABLE, composeWithReview, revisionIssues } from "../lib/pitches/review.ts";
import { PITCH_PROMPT_VERSION, SHOWCASE_PROMPT_VERSION, heldBodyForRevision, isAdviceQuote } from "../lib/pitches/claude-composer.ts";
import { DECISION_VERSION } from "../lib/pitches/decision.ts";
import { __test__ } from "../lib/anthropic/client.ts";
import { loadSiteObservation, siteFactsFor } from "../lib/pitches/site-facts.ts";
import { hasProvenHook, provenFacts, proveInputs } from "../lib/pitches/proven-facts.ts";
import type { ShowcaseBuild } from "../lib/runna/builds.ts";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

const PITCH_URL = new URL("../lib/pitches/pitch-stage.ts", import.meta.url);
const STATUS_URL = new URL("../lib/prospects/status.ts", import.meta.url);
const REAL = new Set(["@/lib/prospects/status", "zod"]);
const stubNames = (url: URL) => [
  ...new Set(
    [...readFileSync(url, "utf8").matchAll(/^import \{([^}]*)\} from "([^"]+)";/gm)]
      .filter(([, , from]) => !REAL.has(from!))
      .flatMap(([, names]) => names!.split(",").map((n) => n.trim()))
      .filter((n) => n && !n.startsWith("type ")),
  ),
];
const TARGETS = { [PITCH_URL.href]: stubNames(PITCH_URL) };
(globalThis as Record<string, unknown>).__sfConsts = { NOT_REVIEWED_ISSUE, WRITER_FIXABLE, PITCH_PROMPT_VERSION, SHOWCASE_PROMPT_VERSION, DECISION_VERSION, ANTHROPIC_DEFAULT_MODEL: "sonnet-x" };
const CONSTS = ["NOT_REVIEWED_ISSUE", "WRITER_FIXABLE", "PITCH_PROMPT_VERSION", "SHOWCASE_PROMPT_VERSION", "DECISION_VERSION", "ANTHROPIC_DEFAULT_MODEL"];
const hooks = `
const STATUS = ${JSON.stringify(STATUS_URL.href)};
const TARGETS = ${JSON.stringify(TARGETS)};
const CONSTS = ${JSON.stringify(CONSTS)};
export async function resolve(spec, ctx, next) {
  if (ctx.parentURL in TARGETS && spec !== "zod") {
    if (spec === "@/lib/prospects/status") return { url: STATUS, shortCircuit: true };
    return { url: "stub:" + ctx.parentURL, shortCircuit: true };
  }
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (!url.startsWith("stub:")) return next(url, ctx);
  const names = TARGETS[url.slice(5)];
  const src = names.map((n) => CONSTS.includes(n) ? "export const " + n + " = globalThis.__sfConsts." + n + ";" : "export const " + n + " = new Proxy(function () {}, { apply: (_t, _s, a) => globalThis.__sfStubs." + n + "(...a), get: (_t, k) => { const v = globalThis.__sfStubs." + n + "; const f = v[k]; return typeof f === 'function' ? f.bind(v) : f; } });").join("\\n");
  return { format: "module", source: src, shortCircuit: true };
}`;
register("data:text/javascript," + encodeURIComponent(hooks));

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };

class Query implements PromiseLike<Result> {
  private op: "select" | "update" | "insert" | "delete" = "select";
  private values: Row = {};
  private one = false;
  private filters: ((r: Row) => boolean)[] = [];
  private tables: Record<string, Row[]>;
  private table: string;
  private fail: Record<string, { message: string }>;
  constructor(tables: Record<string, Row[]>, table: string, fail: Record<string, { message: string }>) { this.tables = tables; this.table = table; this.fail = fail; }
  select() { return this; }
  update(v: Row) { this.op = "update"; this.values = v; return this; }
  insert(v: Row) { this.op = "insert"; this.values = v; return this; }
  delete() { this.op = "delete"; return this; }
  eq(k: string, v: unknown) { this.filters.push((r) => r[k] === v); return this; }
  in(k: string, v: readonly unknown[]) { this.filters.push((r) => v.includes(r[k])); return this; }
  gte(k: string, v: string) { this.filters.push((r) => typeof r[k] !== "string" || String(r[k]) >= v); return this; }
  // order / limit are honoured: "newest" is tested, not assumed.
  private sort: { col: string; asc: boolean } | null = null;
  private lim: number | null = null;
  order(col: string, o: { ascending: boolean } = { ascending: true }) { this.sort = { col, asc: o.ascending }; return this; }
  limit(n: number) { this.lim = n; return this; }
  abortSignal() { return this; }
  returns() { return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }
  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, bad);
  }
  private run(): Result {
    const rows = (this.tables[this.table] ??= []);
    if (this.op === "insert") {
      const row = { id: `00000000-0000-4000-8000-00000000000${rows.length + 1}`, ...this.values };
      rows.push(row);
      return { data: this.one ? { ...row } : [{ ...row }], error: null };
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "select") {
      if (this.fail[this.table]) return { data: null, error: this.fail[this.table]! };
      const sorted = this.sort
        ? [...hit].sort((a, b) => {
            const s = this.sort!;
            const c = String(a[s.col]).localeCompare(String(b[s.col]));
            return s.asc ? c : -c;
          })
        : hit;
      const out = (this.lim === null ? sorted : sorted.slice(0, this.lim)).map((r) => ({ ...r }));
      return { data: this.one ? (out[0] ?? null) : out, error: null };
    }
    if (this.op === "delete") for (const r of hit) rows.splice(rows.indexOf(r), 1);
    else for (const r of hit) Object.assign(r, this.values);
    return { data: null, error: null };
  }
}

type Req = { system?: { text: string }[] | string; messages: { content: string }[] };
const sysText = (r: Req) => (typeof r.system === "string" ? r.system : (r.system ?? []).map((b) => b.text).join("\n"));
const isCritic = (r: Req) => sysText(r).includes("You review a cold email");
const isShowcaseWriter = (r: Req) => !isCritic(r) && r.messages[0]!.content.startsWith("Write the showcase email");
const payloadOf = (r: Req) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(r.messages[0]!.content)![1]!) as Record<string, unknown>;

function fakeClaude(): Req[] {
  const calls: Req[] = [];
  __test__.setClient({
    messages: {
      create: async (r: Req) => {
        calls.push(r);
        const text = isCritic(r)
          ? JSON.stringify({ score: 0.92, issues: [] })
          : isShowcaseWriter(r)
            ? JSON.stringify({
                subject: "ai at hidden acres?", preview_text: "a few tools we've built, and what one could do for the cabins",
                body: "Hi Hidden Acres team,\n\nHenry from Runna Advertising here. Want to use AI at Hidden Acres but not sure where it would help?\n\n👉 {hunter_url}\n\nHenry\nRunna Advertising",
                builds_used: [(payloadOf(r).builds as Array<{ id: string }>)[0]!.id], pain_id: null, contact_email: "ana@hiddenacres.test",
                measurable_result_included: false, quality_self_score: 0.8, reasoning: "x", wanted_fact: null,
              })
            : JSON.stringify({
                subject: "what i noticed on hidden acres' site",
                preview_text: "the book now button and the cabins",
                body: "Hi Ana,\n\nHenry from Runna Advertising here. Your Book Now button sends guests to a separate booking site for the treehouse cabins.\n\n👉 See what our free check finds on Hidden Acres' site, about 30 seconds: {hunter_url}\n\nHenry\nRunna Advertising",
                // The pain the writer was offered: a rewrite's chosen angle, none on a first draft (proveInputs).
                pain_id: (payloadOf(r).pain_candidates as Array<{ pain_id: string | null }>)[0]?.pain_id ?? null,
                contact_email: "ana@hiddenacres.test", measurable_result_included: false, quality_self_score: 0.8, reasoning: "x",
              });
        return { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } };
      },
    },
  } as never);
  return calls;
}

const USER = { id: "u1", tenantId: "t1", role: "admin" };
const PROSPECT_ID = "00000000-0000-4000-8000-0000000000f1";
const PITCH_ID = "00000000-0000-4000-8000-0000000000e1";
const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
const checks = (href: string) => ({
  booking: { found: true, online: true, channel: "external_engine", strength: "strong", evidence: [{ url: "https://hiddenacres.test/", text: "Book Now", href }] },
});
const observation = (over: Row): Row => ({
  tenant_id: "t1", prospect_id: PROSPECT_ID, status: "ok", crawled_at: recent,
  url: "https://hiddenacres.test", final_url: "https://hiddenacres.test/", pages: [{ url: "https://hiddenacres.test/", role: "home" }],
  checks: checks("https://secure.webrez.com/hotel/3530"), psi: null, psi_status: "no_key", ...over,
});

const BUILD: ShowcaseBuild = { id: "daily-briefing", for_whom: "a business owner", does: "a summary every morning", how_it_works: "reads the inbox", universal: true, learns: false };
const EVIDENCE = "no easy way to book a cabin";

async function stage(opts: {
  rewrite?: boolean; observations?: Row[]; failObservations?: boolean; site?: { website_url: string | null; domain: string | null };
  /**
   * pickBuilds' answer (default none). With none, a first draft the proven-facts
   * rule sends to the showcase email still goes to the pain-led writer, so the
   * loader tests can read its site_facts; with builds it is the showcase email.
   */
  builds?: ShowcaseBuild[];
  /** fetchBenchmarksForPitch's answer (default none). */
  benchmarks?: unknown[];
}) {
  const claude = fakeClaude();
  const tables: Record<string, Row[]> = {
    prospects: [{
      id: PROSPECT_ID, tenant_id: "t1", company_name: "Hidden Acres", industry: "lodging", language: "en",
      employee_size_estimate: 5, city: null, market: "CA", domain: "hiddenacres.test", website_url: null, status: "researched", ...opts.site,
    }],
    prospect_research: [{ tenant_id: "t1", prospect_id: PROSPECT_ID, what_they_do: "treehouse cabins", tech_stack: [], pain_points: [{ pain_id: "pain-1", pain_label: "No online booking", evidence_quote: EVIDENCE }] }],
    prospect_contacts: [{ tenant_id: "t1", prospect_id: PROSPECT_ID, email: "ana@hiddenacres.test", email_is_role_based: false, full_name: "Ana", role_title: null, priority_rank: 1 }],
    case_studies: [],
    site_observations: opts.observations ?? [],
    pitches: opts.rewrite ? [{ id: PITCH_ID, tenant_id: "t1", prospect_id: PROSPECT_ID, status: "draft", attribution_code: "code" }] : [],
  };
  const loaded: unknown[] = [];
  (globalThis as Record<string, unknown>).__sfStubs = new Proxy({
    revalidatePath: () => undefined,
    claudeIsAvailable: () => true,
    isUnderDailyCap: async () => ({ under: true, spent_today_usd: 0, cap_usd: 3 }),
    recordClaudeCall: async () => undefined,
    writeAuditLog: async () => undefined,
    hasUsableEmail: (e: unknown) => typeof e === "string" && e.includes("@"),
    isRoleBasedEmail: () => false,
    listNotableClients: async () => [],
    fetchBenchmarksForPitch: async () => opts.benchmarks ?? [],
    // The real loader and site check, against the fake db.
    loadSiteObservation: async (...a: Parameters<typeof loadSiteObservation>) => {
      const row = await loadSiteObservation(...a);
      loaded.push(row);
      return row;
    },
    siteFactsFor,
    // The real rule: only what we can prove reaches the writer (2026-11-09).
    provenFacts,
    hasProvenHook,
    proveInputs,
    webFactsFor: async () => [],
    resolvePainCodes: async (_s: unknown, _t: string, ids: string[]) => ids.map((id) => ({ id, code: id })),
    recordWantedFacts: async () => undefined,
    chooseWriterArms: async () => ({ evidence: "benchmark", guidance: null, showcase: "followup" }),
    isShowcaseArm: (v: unknown) => v === "first" || v === "followup",
    pickBuilds: () => opts.builds ?? [],
    fetchExemplars: async () => [],
    segmentOf: () => "seg",
    newAttributionCode: () => "code",
    senderForGenerator: () => ({ full_name: "Henry", tenant_display_name: "Runna Advertising" }),
    buildHunterUrlForPitch: () => "https://runna-hunter.vercel.app/?market=ca&r=code",
    heldBodyForRevision,
    isAdviceQuote,
    fetchTopUsableContact: async () => null,
    chooseRecipient: (rows: Array<{ email?: unknown }> | null) => rows?.find((c) => typeof c.email === "string" && c.email.includes("@")) ?? null,
    refreshGateAfterChange: async () => null,
    sizeBand: () => "smb",
    registerFor: () => null,
    recipientSummary: () => null,
    detectCitedBenchmark: () => null,
    decisionExemplarFields: () => ({}),
    recordPitchEvent: async () => undefined,
    renderIndustryTemplate: (_i: unknown, why: string) => { throw new Error(`template reached: ${why}`); },
    revisionIssues,
    composeWithReview,
    normalizeMeasurableResults: () => [],
  } as Record<string, unknown>, {
    get(t, name: string) {
      if (t[name] === undefined) throw new Error(`no stub for ${name}`);
      return t[name];
    },
  });
  const supabase = { from: (t: string) => new Query(tables, t, opts.failObservations ? { site_observations: { message: "" } } : {}), rpc: async () => ({ data: null, error: null }) };
  const mod = await import(PITCH_URL.href);
  const result = opts.rewrite
    ? await mod.rewritePitchWithAngleWith({ supabase, user: USER }, { pitch_id: PITCH_ID, pain_id: "pain-1", pain_label: "No online booking", case_study_id: null, capability: null })
    : await mod.generatePitchWith({ supabase, user: USER }, PROSPECT_ID);
  return { result, claude, loaded, tables };
}

/**
 * No site facts for this draft. A rewrite (the person's angle) stays pain-led with
 * site_facts []; a first draft has nothing proven, so it is the showcase email,
 * which carries no site_facts at all (decision.showcase_forced).
 */
function assertNoFacts(rewrite: boolean, run: { claude: Req[]; tables: Record<string, Row[]> }, label?: string) {
  const writer = run.claude.find((c) => !isCritic(c))!;
  const critic = run.claude.find(isCritic)!;
  if (rewrite) {
    assert.deepEqual(payloadOf(writer).site_facts, [], label);
    assert.deepEqual(payloadOf(critic).site_facts, [], label);
    assert.ok(writer.messages[0]!.content.includes("- site_facts is empty: say nothing about their website"), label);
  } else {
    assert.ok(isShowcaseWriter(writer), label);
    assert.equal(payloadOf(writer).site_facts, undefined, label);
    assert.equal(payloadOf(critic).site_facts, undefined, label);
    assert.equal((run.tables.pitches!.at(-1)!.decision as { showcase_forced?: boolean }).showcase_forced, true, label);
  }
}

/** The pain side of proven facts: a first draft gets no research pain; a rewrite gets its chosen angle without the evidence. */
function assertPains(rewrite: boolean, writer: Req, critic: Req) {
  assert.deepEqual(payloadOf(writer).pain_candidates, rewrite ? [{ pain_id: "pain-1", pain_label: "No online booking" }] : []);
  assert.deepEqual(payloadOf(critic).pain_evidence, rewrite ? [{ pain_id: "pain-1", pain: "No online booking" }] : []);
  assert.ok(!writer.messages[0]!.content.includes(EVIDENCE), "the research evidence never reaches the writer");
  assert.ok(!critic.messages[0]!.content.includes(EVIDENCE), "nor the critic");
}

const OTHER_ROWS = [
  // A newer pending claim (unfinished) and an older unreachable crawl never hide the ok row.
  observation({ status: "pending", checks: {}, crawled_at: new Date().toISOString() }),
  observation({ status: "unreachable", checks: checks("https://wrong.example/unreachable"), crawled_at: new Date(Date.now() - 10 * 86_400_000).toISOString() }),
  observation({ tenant_id: "t2", checks: checks("https://wrong.example/other-tenant") }),
  observation({ prospect_id: "00000000-0000-4000-8000-0000000000f2", checks: checks("https://wrong.example/other-prospect") }),
  observation({ crawled_at: old, checks: checks("https://wrong.example/too-old") }),
];

for (const rewrite of [false, true]) {
  const name = rewrite ? "rewritePitchWithAngleWith" : "generatePitchWith";

  test(`${name}: the newest ok observation of this tenant's prospect reaches the writer and the critic as the same site_facts`, async () => {
    const { result, claude, loaded } = await stage({ rewrite, observations: [...OTHER_ROWS, observation({})] });
    assert.equal(result.ok, true, result.error);
    assert.equal(loaded.length, 1, "read once");
    const writer = claude.find((c) => !isCritic(c))!;
    const critic = claude.find(isCritic)!;
    const facts = payloadOf(writer).site_facts as Array<{ id: string; fact: string; url: string }>;
    assert.deepEqual(facts.map((f) => f.fact), ["Their 'Book Now' button goes to an outside booking engine (secure.webrez.com)"]);
    assert.deepEqual(payloadOf(critic).site_facts, facts);
    assert.ok(!JSON.stringify(facts).includes("wrong.example"), "pending, unreachable, another tenant's, another prospect's or a 90-day-old row never counts");
    assertPains(rewrite, writer, critic);
  });

  test(`${name}: an ok crawl of another site (website_url / domain corrected since) gives no site facts`, async () => {
    const wrong = observation({ url: "https://wrong.example", final_url: "https://wrong.example/" });
    const run = await stage({ rewrite, observations: [wrong], site: { website_url: "https://right.example", domain: "right.example" }, builds: [BUILD] });
    assert.equal(run.result.ok, true, run.result.error);
    assertNoFacts(rewrite, run);
  });

  test(`${name}: the newest finished crawl decides: a newer ok row wins over an older one, a newer unreachable one stops older ok facts`, async () => {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const older = observation({ crawled_at: day(20), checks: checks("https://older.example/book") });
    const newer = observation({ crawled_at: day(2) });
    const r1 = await stage({ rewrite, observations: [older, newer] });
    const facts = payloadOf(r1.claude.find((c) => !isCritic(c))!).site_facts as Array<{ fact: string }>;
    assert.deepEqual(facts.map((f) => f.fact), ["Their 'Book Now' button goes to an outside booking engine (secure.webrez.com)"]);
    // A pending re-crawl is not finished: the ok row still counts.
    const r2 = await stage({ rewrite, observations: [newer, observation({ crawled_at: day(0), status: "pending", checks: {} })] });
    assert.equal((payloadOf(r2.claude.find((c) => !isCritic(c))!).site_facts as unknown[]).length, 1);
    for (const status of ["unreachable", "blocked", "offsite"]) {
      const r = await stage({ rewrite, observations: [older, newer, observation({ crawled_at: day(1), status })], builds: [BUILD] });
      assertNoFacts(rewrite, r, status);
    }
  });

  // A first draft with nothing proven is the showcase email (2026-11-09): it drafts anyway, with no site_facts at all.
  // A rewrite keeps the person's angle: the pain-led email, with site_facts [].
  test(`${name}: no row, or a read error, drafts anyway: ${rewrite ? "site_facts []" : "the showcase email, no site_facts"}`, async () => {
    const warn = mock.method(console, "warn", () => undefined);
    try {
      for (const opts of [{ observations: [] }, { observations: OTHER_ROWS }, { observations: [observation({})], failObservations: true }]) {
        const run = await stage({ rewrite, builds: [BUILD], ...opts });
        assert.equal(run.result.ok, true, run.result.error);
        assertNoFacts(rewrite, run);
        if (rewrite) assertPains(rewrite, run.claude.find((c) => !isCritic(c))!, run.claude.find(isCritic)!);
      }
    } finally {
      warn.mock.restore();
    }
  });
}

// ── Which email a first draft gets (proven facts, 2026-11-09) ────────────────

test("generatePitchWith: a prospect with only context facts (no problem or opening) gets the showcase email, decision.showcase_forced true", async () => {
  // The Book Now fact is seen and true, but no reason to write: the arm test said "followup", the rule overrides it.
  const { result, claude, tables } = await stage({ observations: [observation({})], builds: [BUILD] });
  assert.equal(result.ok, true, result.error);
  const writer = claude.find((c) => !isCritic(c))!;
  const critic = claude.find(isCritic)!;
  assert.ok(isShowcaseWriter(writer), "the showcase writer ran");
  assert.deepEqual((payloadOf(writer).builds as Array<{ id: string }>).map((b) => b.id), [BUILD.id]);
  assert.equal(payloadOf(writer).site_facts, undefined);
  assert.equal(payloadOf(critic).site_facts, undefined);
  assert.ok(!writer.messages[0]!.content.includes(EVIDENCE) && !critic.messages[0]!.content.includes(EVIDENCE));
  const decision = tables.pitches!.at(-1)!.decision as { showcase_forced?: boolean; arms?: Record<string, unknown>; builds_offered?: string[]; prompt_version?: string };
  assert.equal(decision.showcase_forced, true);
  assert.deepEqual(decision.arms, { "writer.showcase": "first" });
  assert.deepEqual(decision.builds_offered, [BUILD.id]);
  assert.equal(decision.prompt_version, SHOWCASE_PROMPT_VERSION);
});

test("generatePitchWith: a PageSpeed score Google rates as poor (a seen problem) keeps the problem-led email", async () => {
  const psi = { psi_status: "ok", psi: { scores: { performance: 0.31 }, final_url: "https://hiddenacres.test/" } };
  // The library has a figure for the research pain: a first draft has no pain, so it is offered none.
  const benchmark = { id: "b1", statistic: "About 70% of guests book online.", figure: "70%", publisher: "Phocuswright", source_url: "https://x.test", caveat: null, for_pains: [{ code: "no_online_booking", label: "No online booking", pain_id: "pain-1" }] };
  const { result, claude, tables } = await stage({ observations: [observation(psi)], builds: [BUILD], benchmarks: [benchmark] });
  assert.equal(result.ok, true, result.error);
  const writer = claude.find((c) => !isCritic(c))!;
  const critic = claude.find(isCritic)!;
  assert.ok(!isShowcaseWriter(writer), "the pain-led writer ran");
  const facts = payloadOf(writer).site_facts as Array<{ id: string; fact: string; hook: string }>;
  assert.deepEqual(facts.map((f) => [f.id, f.hook]), [["booking", "context"], ["psi", "problem"]]);
  assert.match(facts[1]!.fact, /scored the home page 31\/100 for performance, which Google rates as poor$/);
  assert.deepEqual(payloadOf(critic).site_facts, facts);
  assertPains(false, writer, critic);
  const decision = tables.pitches!.at(-1)!.decision as { showcase_forced?: boolean; arms?: Record<string, unknown>; prompt_version?: string; benchmarks_offered?: unknown[] };
  assert.equal(decision.showcase_forced, undefined);
  assert.equal(decision.arms?.["writer.showcase"], "followup");
  // No pain, no figure (proveInputs): neither the writer nor the critic sees it, the record says none
  // was offered, and the evidence test is not recorded (both of its arms would write this same email).
  assert.deepEqual(payloadOf(writer).benchmarks, []);
  assert.deepEqual(payloadOf(critic).benchmarks, []);
  assert.deepEqual(decision.benchmarks_offered, []);
  assert.equal(Object.hasOwn(decision.arms ?? {}, "writer.evidence"), false);
  assert.equal(decision.prompt_version, PITCH_PROMPT_VERSION);
});
