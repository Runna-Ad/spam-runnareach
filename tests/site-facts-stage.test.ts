/**
 * Brief tasks/briefs/site-facts-writer.md, the loaders: generatePitchWith and
 * rewritePitchWithAngleWith both read the newest ok site observation of THIS
 * tenant's prospect and hand the same site_facts to the writer and the
 * critic; no row or a read error drafts anyway with site_facts []. Drives the
 * real stage, the real loader and the real write → review loop (SDK faked);
 * every other import of pitch-stage.ts is stubbed by a loader hook (same
 * harness as tests/wanted-facts-writer.test.ts).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test, { mock } from "node:test";
import { NOT_REVIEWED_ISSUE, WRITER_FIXABLE, composeWithReview, revisionIssues } from "../lib/pitches/review.ts";
import { PITCH_PROMPT_VERSION, SHOWCASE_PROMPT_VERSION, heldBodyForRevision, isAdviceQuote } from "../lib/pitches/claude-composer.ts";
import { DECISION_VERSION } from "../lib/pitches/decision.ts";
import { __test__ } from "../lib/anthropic/client.ts";
import { loadSiteFacts } from "../lib/pitches/site-facts.ts";

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
  in(k: string, v: unknown[]) { this.filters.push((r) => v.includes(r[k])); return this; }
  gte(k: string, v: string) { this.filters.push((r) => typeof r[k] !== "string" || String(r[k]) >= v); return this; }
  order() { return this; }
  limit() { return this; }
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
      const out = hit.map((r) => ({ ...r }));
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
const payloadOf = (r: Req) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(r.messages[0]!.content)![1]!) as Record<string, unknown>;

function fakeClaude(): Req[] {
  const calls: Req[] = [];
  __test__.setClient({
    messages: {
      create: async (r: Req) => {
        calls.push(r);
        const text = isCritic(r)
          ? JSON.stringify({ score: 0.92, issues: [] })
          : JSON.stringify({
              subject: "what i noticed on hidden acres' site",
              preview_text: "the book now button and the cabins",
              body: "Hi Ana,\n\nHenry from Runna Advertising here. Your Book Now button sends guests to a separate booking site for the treehouse cabins.\n\n👉 See what our free check finds on Hidden Acres' site, about 30 seconds: {hunter_url}\n\nHenry\nRunna Advertising",
              pain_id: "pain-1", contact_email: "ana@hiddenacres.test", measurable_result_included: false, quality_self_score: 0.8, reasoning: "x",
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

async function stage(opts: { rewrite?: boolean; observations?: Row[]; failObservations?: boolean }) {
  const claude = fakeClaude();
  const tables: Record<string, Row[]> = {
    prospects: [{
      id: PROSPECT_ID, tenant_id: "t1", company_name: "Hidden Acres", industry: "lodging", language: "en",
      employee_size_estimate: 5, city: null, market: "CA", domain: "hiddenacres.test", website_url: null, status: "researched",
    }],
    prospect_research: [{ tenant_id: "t1", prospect_id: PROSPECT_ID, what_they_do: "treehouse cabins", tech_stack: [], pain_points: [{ pain_id: "pain-1", pain_label: "No online booking", evidence_quote: "no easy way to book a cabin" }] }],
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
    fetchBenchmarksForPitch: async () => [],
    // The real loader, against the fake db.
    loadSiteFacts: async (...a: Parameters<typeof loadSiteFacts>) => {
      const facts = await loadSiteFacts(...a);
      loaded.push(facts);
      return facts;
    },
    resolvePainCodes: async (_s: unknown, _t: string, ids: string[]) => ids.map((id) => ({ id, code: id })),
    recordWantedFacts: async () => undefined,
    chooseWriterArms: async () => ({ evidence: "benchmark", guidance: null, showcase: "followup" }),
    isShowcaseArm: (v: unknown) => v === "first" || v === "followup",
    pickBuilds: () => [],
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
  return { result, claude, loaded };
}

const OTHER_ROWS = [
  observation({ status: "pending", checks: {} }),
  observation({ status: "unreachable", checks: checks("https://wrong.example/unreachable") }),
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
  });

  test(`${name}: no row, or a read error, drafts anyway with site_facts []`, async () => {
    const warn = mock.method(console, "warn", () => undefined);
    try {
      for (const opts of [{ observations: [] }, { observations: OTHER_ROWS }, { observations: [observation({})], failObservations: true }]) {
        const { result, claude } = await stage({ rewrite, ...opts });
        assert.equal(result.ok, true, result.error);
        const writer = claude.find((c) => !isCritic(c))!;
        assert.deepEqual(payloadOf(writer).site_facts, []);
        assert.deepEqual(payloadOf(claude.find(isCritic)!).site_facts, []);
        assert.ok(writer.messages[0]!.content.includes("- site_facts is empty: say nothing about their website"));
      }
    } finally {
      warn.mock.restore();
    }
  });
}
