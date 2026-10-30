/**
 * Brief tasks/briefs/wanted-facts-writer.md. The writer and the critic may name
 * a statistic the benchmark library lacks (wanted_fact); the kept draft's wishes
 * are recorded through record_wanted_fact (0050), best-effort, and nothing
 * about the email changes because of them.
 *
 * The stage tests drive the real generatePitchWith / rewritePitchWithAngleWith
 * against a fake Supabase client, with the real write → review loop and the
 * real recorder (the SDK is faked). Every other import of pitch-stage.ts is a
 * stub from a loader hook, same harness as tests/pitch-rewrite-notes-stage.test.ts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test, { mock } from "node:test";
import { NOT_REVIEWED_ISSUE, WRITER_FIXABLE, composeWithReview, revisionIssues } from "../lib/pitches/review.ts";
import { PITCH_PROMPT_VERSION, composePitchWithClaude, heldBodyForRevision, isAdviceQuote } from "../lib/pitches/claude-composer.ts";
import { DECISION_VERSION, type DecisionRecord } from "../lib/pitches/decision.ts";
import { __test__ } from "../lib/anthropic/client.ts";
import { cleanWantedFact, recordWantedFacts, wantedFactKey } from "../lib/benchmarks/wanted-facts.ts";
import type { GeneratorInputs } from "../lib/pitches/generator.ts";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

// ── 1. The discard checks (pure) ──────────────────────────────────────────────

test("discard: a digit anywhere, too short, too long, the company's name; keep a plain wish", () => {
  const ok = "share of small online stores with no abandoned-cart email";
  assert.equal(cleanWantedFact(ok, "Boutique Lila"), ok);
  assert.equal(cleanWantedFact(`  ${ok}\n`, "Boutique Lila"), ok, "trimmed, whitespace collapsed");

  // Digit: the wish is the question, not the answer.
  assert.equal(cleanWantedFact("70% of small stores send no cart email", null), null);
  assert.equal(cleanWantedFact("how many stores in 2024 send cart emails", null), null);
  assert.equal(cleanWantedFact("stores with 1 location and no cart email", null), null);

  // Length after trim: 8..300, the 0050 CHECK.
  assert.equal(cleanWantedFact("  cart?  ", null), null);
  assert.equal(cleanWantedFact("a".repeat(7), null), null);
  assert.equal(cleanWantedFact("a".repeat(8), null), "a".repeat(8));
  assert.equal(cleanWantedFact("a".repeat(300), null), "a".repeat(300));
  assert.equal(cleanWantedFact("a".repeat(301), null), null);

  // Names the prospect: case- and accent-insensitive substring, name of 4+ chars.
  assert.equal(cleanWantedFact("how often Boutique Lila customers abandon carts", "Boutique Lila"), null);
  assert.equal(cleanWantedFact("how often boutique lila customers abandon carts", "BOUTIQUE LILA"), null);
  assert.equal(cleanWantedFact("share of clinica sur patients who book online", "Clínica Sur"), null);
  // A 3-letter name would match ordinary words ("ABC" in "abcde"); not applied.
  assert.equal(cleanWantedFact("share of abc stores with no cart email", "ABC"), "share of abc stores with no cart email");

  // Not text at all.
  for (const v of [null, undefined, 42, { fact: ok }, [ok]]) assert.equal(cleanWantedFact(v, null), null);
});

// ── 2. The recorder (fake rpc) ───────────────────────────────────────────────

/** The 0050 function's parameters: a call with any other key is a bug the real database would refuse. */
const RPC_PARAMS = ["p_tenant_id", "p_fact", "p_source", "p_pain_code", "p_industry", "p_market", "p_pitch_id"].sort();

type RpcCall = { fn: string; args: Record<string, unknown>; signal: AbortSignal | null };
type RpcMode = "ok" | "error" | "empty_error" | "throw" | "hang" | "hang_ignoring_abort";

function fakeRpc(mode: RpcMode = "ok") {
  const calls: RpcCall[] = [];
  const rpc = (fn: string, args: Record<string, unknown>) => {
    const call: RpcCall = { fn, args, signal: null };
    calls.push(call);
    assert.equal(fn, "record_wanted_fact");
    assert.deepEqual(Object.keys(args).sort(), RPC_PARAMS);
    return {
      abortSignal(signal: AbortSignal) {
        call.signal = signal;
        if (mode === "throw") return Promise.reject(new Error("network down"));
        if (mode === "hang") {
          return new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve({ data: null, error: { message: "AbortError: aborted" } })),
          );
        }
        if (mode === "hang_ignoring_abort") return new Promise(() => undefined);
        if (mode === "error") return Promise.resolve({ data: null, error: { message: 'new row violates check constraint "wanted_facts_fact_check"' } });
        if (mode === "empty_error") return Promise.resolve({ data: null, error: { message: "" } });
        return Promise.resolve({ data: "row-id", error: null });
      },
    };
  };
  return { client: { rpc } as never, rpc, calls };
}

const REQ = {
  tenantId: "t1",
  pitchId: "pitch-1",
  companyName: "Boutique Lila",
  industry: "retail",
  market: "CA",
  writer: "share of small online stores with no abandoned-cart email",
  critic: "how many shoppers come back after a cart reminder",
  painCode: async () => "abandoned_cart_loss",
};

test("recorder: one call per source, with the pitch id, the pain code and the segment", async () => {
  const { client, calls } = fakeRpc();
  assert.equal(await recordWantedFacts(client, REQ), 2);
  assert.deepEqual(calls.map((c) => c.args), [
    { p_tenant_id: "t1", p_fact: REQ.writer, p_source: "writer", p_pain_code: "abandoned_cart_loss", p_industry: "retail", p_market: "CA", p_pitch_id: "pitch-1" },
    { p_tenant_id: "t1", p_fact: REQ.critic, p_source: "critic", p_pain_code: "abandoned_cart_loss", p_industry: "retail", p_market: "CA", p_pitch_id: "pitch-1" },
  ]);
  assert.ok(calls.every((c) => c.signal instanceof AbortSignal), "every call has a time limit");
});

test("recorder: discarded or absent wishes make no call and no pain lookup; one wish asked twice is one call", async () => {
  let lookups = 0;
  const painCode = async () => { lookups++; return "abandoned_cart_loss"; };
  const none = fakeRpc();
  assert.equal(await recordWantedFacts(none.client, { ...REQ, writer: "70% of stores", critic: null, painCode }), 0);
  assert.equal(await recordWantedFacts(none.client, { ...REQ, writer: undefined, critic: "  ", painCode }), 0);
  assert.equal(await recordWantedFacts(none.client, { ...REQ, writer: "Boutique Lila's cart abandonment rate", critic: undefined, painCode }), 0);
  assert.equal(none.calls.length, 0);
  assert.equal(lookups, 0);

  const same = fakeRpc();
  assert.equal(await recordWantedFacts(same.client, { ...REQ, critic: `${REQ.writer.toUpperCase()}!`, painCode }), 1);
  assert.equal(same.calls.length, 1);
  assert.equal(same.calls[0]!.args.p_source, "writer");
  assert.equal(wantedFactKey("Share of stores, no cart-email!"), "share of stores no cart email");
});

test("recorder: an unknown pain is null; a pain lookup that throws records with null", async () => {
  const a = fakeRpc();
  await recordWantedFacts(a.client, { ...REQ, critic: null, painCode: async () => null });
  assert.equal(a.calls[0]!.args.p_pain_code, null);
  const b = fakeRpc();
  await recordWantedFacts(b.client, { ...REQ, critic: null, painCode: async () => { throw new Error("db down"); } });
  assert.equal(b.calls[0]!.args.p_pain_code, null);
});

test("recorder: an error (CHECK raise, empty-body 5xx) or a throw resolves 0 with a warning, never rejects", async () => {
  const warn = mock.method(console, "warn", () => undefined);
  try {
    for (const mode of ["error", "empty_error", "throw"] as const) {
      const { client } = fakeRpc(mode);
      assert.equal(await recordWantedFacts(client, REQ), 0, mode);
    }
    assert.ok(warn.mock.callCount() >= 6);
    assert.ok(warn.mock.calls.some((c) => (c.arguments as unknown[]).includes("no message")), "empty message reported, not read as success");
  } finally {
    warn.mock.restore();
  }
});

test("recorder: a hang settles at the time limit, whether or not the call honours the abort (fake timers)", async () => {
  const warn = mock.method(console, "warn", () => undefined);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // Ignores the abort: the recorder's own cap (3 s + 0.5 s) ends it.
    const stuck = fakeRpc("hang_ignoring_abort");
    let settled: number | null = null;
    const p = recordWantedFacts(stuck.client, REQ).then((n) => { settled = n; });
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(3_400);
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, null, "still waiting before the cap");
    mock.timers.tick(200);
    await p;
    assert.equal(settled, 0);
  } finally {
    mock.timers.reset();
    warn.mock.restore();
  }
  // Honours the abort: AbortSignal.timeout(3 s) is what each call is given.
  const quiet = mock.method(console, "warn", () => undefined);
  try {
    const { client, calls } = fakeRpc("hang");
    const started = Date.now();
    assert.equal(await recordWantedFacts(client, REQ, { timeoutMs: 50 }), 0);
    assert.ok(Date.now() - started < 1_000);
    assert.ok(calls.every((c) => c.signal?.aborted));
  } finally {
    quiet.mock.restore();
  }
});

// ── 3. Writer and critic schemas: the wish never moves the email ─────────────

type Req = { system?: { text: string }[] | string; messages: { content: string }[] };
const sysText = (r: Req) => (typeof r.system === "string" ? r.system : (r.system ?? []).map((b) => b.text).join("\n"));
const isCritic = (r: Req) => sysText(r).includes("You review a cold email");

const PAIN = "11111111-1111-4111-8111-111111111111";
const TAIL = "\n\n👉 Run Clinica Sur through our free check, about 30 seconds: {hunter_url}\n\nHenry\nRunna Advertising";
const draftBody = (n: number) =>
  `Hi Ana,\n\nHenry from Runna Advertising here. Right now the only way to reach Clinica Sur online is a contact form (draft ${["one", "two", "three"][n - 1]}).` + TAIL;

function writerJson(n: number, wanted?: unknown) {
  return JSON.stringify({
    subject: "contact form only at clinica sur",
    preview_text: "the only way in after hours is a contact form",
    body: draftBody(n),
    pain_id: PAIN,
    contact_email: "ana@clinicasur.ca",
    measurable_result_included: false,
    quality_self_score: 0.8,
    reasoning: "x",
    ...(wanted === undefined ? {} : { wanted_fact: wanted }),
  });
}

/**
 * Three drafts: the critic blocks drafts one and two and passes three. Wishes
 * on drafts one and three (writer and critic) unless `wishes` is false.
 */
function threeDrafts(wishes: boolean) {
  let composes = 0;
  __test__.setClient({
    messages: {
      create: async (r: Req) => {
        let text: string;
        if (isCritic(r)) {
          const body = r.messages[0]!.content;
          const n = body.includes("(draft three)") ? 3 : body.includes("(draft two)") ? 2 : 1;
          text = JSON.stringify({
            score: n === 3 ? 0.92 : 0.6,
            issues: n === 3 ? [] : [{ issue: "Say what the form costs them in general terms", blocking: true }],
            ...(wishes && n !== 2 ? { wanted_fact: `critic wish from draft ${["one", "two", "three"][n - 1]}` } : {}),
          });
        } else {
          composes++;
          const n = composes;
          text = writerJson(n, wishes && n !== 2 ? `writer wish from draft ${["one", "two", "three"][n - 1]}` : undefined);
        }
        return { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } };
      },
    },
  } as never);
}

function inputs(): GeneratorInputs {
  return {
    prospect: { id: "p", company_name: "Clinica Sur", industry: "clinic", language: "en", employee_size_estimate: 5, city: null, market: "CA", what_they_do: "family dental clinic", tech_stack: [] },
    pains: [{ pain_id: PAIN, pain_label: "Lead response time", evidence_quote: "contact form only, no online booking" }],
    contacts: [{ full_name: "Ana", email: "ana@clinicasur.ca", email_is_role_based: false, role_title: null }],
    case_studies: [],
    notable_clients: [],
    benchmarks: [],
    sender: { full_name: "Henry", tenant_display_name: "Runna Advertising" },
    deep_pitch_url: "https://runna-hunter.vercel.app/?market=ca&r=code",
  };
}

test("review loop: the kept draft's wishes only (drafts one and three wish, three is kept)", async () => {
  threeDrafts(true);
  const r = await composeWithReview(inputs(), { deadline: Date.now() + 120_000 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.critic?.revisions, 2);
  assert.match(r.composed.body, /draft three/);
  assert.deepEqual(r.wanted, { writer: "writer wish from draft three", critic: "critic wish from draft three" });
});

test("byte-identical: subject, body, pain, critic score/issues/pass and gate findings with and without wishes", async () => {
  const strip = (r: Awaited<ReturnType<typeof composeWithReview>>) => {
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("not ok");
    const { wanted_fact: _w, ...composed } = r.composed;
    return { composed, critic: r.critic, writing: r.writing, model: r.model };
  };
  threeDrafts(true);
  const withWishes = await composeWithReview(inputs(), { deadline: Date.now() + 120_000 });
  threeDrafts(false);
  const without = await composeWithReview(inputs(), { deadline: Date.now() + 120_000 });
  assert.deepEqual(strip(withWishes), strip(without));
  assert.ok(withWishes.ok && withWishes.wanted.writer && without.ok && without.wanted.writer === null);
});

test("schema: any wanted_fact shape (number, object, empty, absent) parses; the pitch is never lost to it", async () => {
  for (const wanted of [undefined, null, "", "   ", 42, { a: 1 }, ["x"], "x".repeat(5_000)]) {
    __test__.setClient({
      messages: { create: async () => ({ content: [{ type: "text", text: writerJson(1, wanted) }], usage: { input_tokens: 1, output_tokens: 1 } }) },
    } as never);
    const r = await composePitchWithClaude(inputs());
    assert.equal(r.ok, true, JSON.stringify(wanted));
    if (!r.ok) continue;
    const w = r.result.composed.wanted_fact;
    if (typeof wanted === "string" && wanted.trim()) assert.equal(w, wanted.trim().slice(0, 1000));
    else assert.equal(w, null, JSON.stringify(wanted));
  }
});

test("prompts: the writer is told when to name a wanted fact and how; the critic too; version v3.4", async () => {
  const seen: Req[] = [];
  __test__.setClient({
    messages: {
      create: async (r: Req) => {
        seen.push(r);
        const text = isCritic(r) ? JSON.stringify({ score: 0.95, issues: [] }) : writerJson(1);
        return { content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  } as never);
  await composeWithReview(inputs(), { deadline: Date.now() + 120_000 });
  const writer = sysText(seen.find((r) => !isCritic(r))!);
  const critic = sysText(seen.find(isCritic)!);
  assert.match(writer, /none of payload\.benchmarks has the pain you lead with in for_pains, write no number in the email and put the fact you wish you had in wanted_fact/);
  assert.match(writer, /"wanted_fact": string \| null/);
  assert.match(critic, /WANTED FACT:/);
  assert.match(critic, /"wanted_fact": string \| null/);
  assert.match(critic, /never changes the score or the issues/);
  assert.equal(PITCH_PROMPT_VERSION, "pitch-v3.4-2026-10-30");
});

test("rewrite directive: no blanket number ban; the angle's pain_id pairs with the benchmark tagged for it", async () => {
  const seen: Req[] = [];
  __test__.setClient({
    messages: { create: async (r: Req) => { seen.push(r); return { content: [{ type: "text", text: writerJson(1) }], usage: { input_tokens: 1, output_tokens: 1 } }; } },
  } as never);
  // forced_angle.pain_id comes from the same prospect_research.pain_points row as
  // pain_candidates (angle-advisor normalizePains → painId), so it has the same form.
  await composePitchWithClaude({
    ...inputs(),
    benchmarks: [{
      id: "b1", statistic: "firms that reply within the hour win more conversations", figure: "7 times", publisher: "HBR",
      source_url: "https://hbr.org", caveat: null, for_pains: [{ code: "lead_response_time", label: "Slow replies", pain_id: PAIN }],
    }],
    forced_angle: { pain_label: "Slow replies", pain_id: PAIN, case_study_id: null, capability: null },
  });
  const user = seen[0]!.messages[0]!.content;
  assert.match(user, new RegExp(`Lead with this pain: "Slow replies" \\(pain_id ${PAIN}\\)`));
  assert.match(user, /no client; a number only as FACTS 2 allows \(a benchmark whose for_pains includes this pain\)/);
  assert.doesNotMatch(user, /no client, no number/);
  const payload = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(user)![1]!) as {
    pain_candidates: Array<{ pain_id: string }>;
    benchmarks: Array<{ for_pains: Array<{ pain_id: string }> }>;
  };
  assert.equal(payload.benchmarks[0]!.for_pains[0]!.pain_id, PAIN);
  assert.equal(payload.pain_candidates[0]!.pain_id, PAIN);
});

// ── 4. The stage: generatePitchWith / rewritePitchWithAngleWith ──────────────

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
(globalThis as Record<string, unknown>).__wfConsts = { NOT_REVIEWED_ISSUE, WRITER_FIXABLE, PITCH_PROMPT_VERSION, DECISION_VERSION, ANTHROPIC_DEFAULT_MODEL: "sonnet-x" };
const CONSTS = ["NOT_REVIEWED_ISSUE", "WRITER_FIXABLE", "PITCH_PROMPT_VERSION", "DECISION_VERSION", "ANTHROPIC_DEFAULT_MODEL"];
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
  const src = names.map((n) => CONSTS.includes(n) ? "export const " + n + " = globalThis.__wfConsts." + n + ";" : "export const " + n + " = new Proxy(function () {}, { apply: (_t, _s, a) => globalThis.__wfStubs." + n + "(...a), get: (_t, k) => { const v = globalThis.__wfStubs." + n + "; const f = v[k]; return typeof f === 'function' ? f.bind(v) : f; } });").join("\\n");
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
  constructor(tables: Record<string, Row[]>, table: string) { this.tables = tables; this.table = table; }
  select() { return this; }
  update(v: Row) { this.op = "update"; this.values = v; return this; }
  insert(v: Row) { this.op = "insert"; this.values = v; return this; }
  delete() { this.op = "delete"; return this; }
  eq(k: string, v: unknown) { this.filters.push((r) => r[k] === v); return this; }
  in(k: string, v: unknown[]) { this.filters.push((r) => v.includes(r[k])); return this; }
  gte() { return this; }
  order() { return this; }
  limit() { return this; }
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
      const out = hit.map((r) => ({ ...r }));
      return { data: this.one ? (out[0] ?? null) : out, error: null };
    }
    if (this.op === "delete") for (const r of hit) rows.splice(rows.indexOf(r), 1);
    else for (const r of hit) Object.assign(r, this.values);
    return { data: null, error: null };
  }
}

const USER = { id: "u1", tenantId: "t1", role: "admin" };
/** A sourced statistic about the lead pain: the library HAS it. */
const LEAD_PAIN_BENCHMARK = {
  id: "b1", statistic: "firms that reply within the hour get more conversations", figure: "7 times", publisher: "HBR",
  source_url: "https://hbr.org", caveat: null, for_pains: [{ code: "lead_response_time", label: "Lead response time", pain_id: PAIN }],
};
const PROSPECT_ID = "00000000-0000-4000-8000-0000000000f1";
const EXISTING_PITCH = "00000000-0000-4000-8000-0000000000e1";

async function stage(opts: { rpc?: RpcMode; wishes?: boolean; rewrite?: boolean; arm?: "benchmark" | "no_benchmark"; leadPainBenchmark?: boolean }) {
  threeDrafts(opts.wishes ?? true);
  const tables: Record<string, Row[]> = {
    prospects: [{
      id: PROSPECT_ID, tenant_id: "t1", company_name: "Clinica Sur", industry: "clinic", language: "en",
      employee_size_estimate: 5, city: null, market: "CA", domain: "clinicasur.ca", website_url: null, status: "researched",
    }],
    prospect_research: [{ tenant_id: "t1", prospect_id: PROSPECT_ID, what_they_do: "family dental clinic", tech_stack: [], pain_points: [{ pain_id: PAIN, pain_label: "Lead response time", evidence_quote: "contact form only, no online booking" }] }],
    prospect_contacts: [{ tenant_id: "t1", prospect_id: PROSPECT_ID, email: "ana@clinicasur.ca", email_is_role_based: false, full_name: "Ana", role_title: null, priority_rank: 1 }],
    case_studies: [],
    pitches: opts.rewrite ? [{ id: EXISTING_PITCH, tenant_id: "t1", prospect_id: PROSPECT_ID, status: "draft", attribution_code: "code" }] : [],
  };
  const rpc = fakeRpc(opts.rpc ?? "ok");
  const resolved: string[][] = [];
  (globalThis as Record<string, unknown>).__wfStubs = new Proxy({
    revalidatePath: () => undefined,
    claudeIsAvailable: () => true,
    isUnderDailyCap: async () => ({ under: true, spent_today_usd: 0, cap_usd: 3 }),
    recordClaudeCall: async () => undefined,
    writeAuditLog: async () => undefined,
    hasUsableEmail: (e: unknown) => typeof e === "string" && e.includes("@"),
    isRoleBasedEmail: () => false,
    listNotableClients: async () => [],
    fetchBenchmarksForPitch: async () => (opts.leadPainBenchmark ? [LEAD_PAIN_BENCHMARK] : []),
    loadSiteObservation: async () => null,
    siteFactsFor: () => [],
    resolvePainCodes: async (_s: unknown, _t: string, ids: string[]) => {
      resolved.push(ids);
      return ids.map((id) => ({ id, code: id === PAIN ? "lead_response_time" : id }));
    },
    recordWantedFacts,
    chooseWriterArms: async () => ({ evidence: opts.arm ?? "benchmark", guidance: null }),
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
  const supabase = { from: (t: string) => new Query(tables, t), rpc: rpc.rpc };
  const mod = await import(PITCH_URL.href);
  const started = Date.now();
  const result = opts.rewrite
    ? await mod.rewritePitchWithAngleWith({ supabase, user: USER }, {
        pitch_id: EXISTING_PITCH, pain_id: PAIN, pain_label: "Lead response time", case_study_id: null, capability: null,
      })
    : await mod.generatePitchWith({ supabase, user: USER }, PROSPECT_ID);
  return { result, ms: Date.now() - started, tables, rpcCalls: rpc.calls, resolved };
}

test("stage: one writer and one critic call, draft three's text, the pitch id, the resolved pain code; decision keeps the writer's wish", async () => {
  const { result, tables, rpcCalls, resolved } = await stage({});
  assert.equal(result.ok, true, result.error);
  const pitch = tables.pitches![0]!;
  assert.equal(pitch.id, result.pitch_id);
  assert.match(String(pitch.body_original), /draft three/);
  assert.deepEqual(rpcCalls.map((c) => c.args), [
    { p_tenant_id: "t1", p_fact: "writer wish from draft three", p_source: "writer", p_pain_code: "lead_response_time", p_industry: "clinic", p_market: "CA", p_pitch_id: result.pitch_id },
    { p_tenant_id: "t1", p_fact: "critic wish from draft three", p_source: "critic", p_pain_code: "lead_response_time", p_industry: "clinic", p_market: "CA", p_pitch_id: result.pitch_id },
  ]);
  assert.deepEqual(resolved, [[PAIN]], "the writer's chosen pain_id, resolved once");
  const decision = pitch.decision as DecisionRecord;
  assert.equal(decision.wanted_fact, "writer wish from draft three");
  assert.equal(decision.prompt_version, PITCH_PROMPT_VERSION);
});

test("stage: the saved pitch and its decision are the same with and without wishes", async () => {
  const a = await stage({ wishes: true });
  const b = await stage({ wishes: false });
  assert.equal(b.rpcCalls.length, 0);
  const norm = (rows: Row[]) => rows.map(({ decision, ...row }) => {
    const { created_at: _c, wanted_fact: _w, ...d } = decision as DecisionRecord;
    return { ...row, decision: d };
  });
  assert.deepEqual(norm(a.tables.pitches!), norm(b.tables.pitches!));
  assert.equal((b.tables.pitches![0]!.decision as DecisionRecord).wanted_fact, null);
});

test("stage: an RPC error, a CHECK raise or a throw leaves the pitch saved exactly as without the feature", async () => {
  const warn = mock.method(console, "warn", () => undefined);
  try {
    const baseline = await stage({ wishes: true });
    for (const rpc of ["error", "empty_error", "throw"] as const) {
      const r = await stage({ rpc });
      assert.equal(r.result.ok, true, rpc);
      assert.deepEqual(r.tables.pitches, baseline.tables.pitches?.map((p) => ({ ...p, decision: { ...(p.decision as object), created_at: (r.tables.pitches![0]!.decision as DecisionRecord).created_at } })), rpc);
    }
  } finally {
    warn.mock.restore();
  }
});

test("stage: a 5 s hang that ignores the abort still returns, pitch saved, in about 3.5 s", async () => {
  const warn = mock.method(console, "warn", () => undefined);
  try {
    const r = await stage({ rpc: "hang_ignoring_abort" });
    assert.equal(r.result.ok, true);
    assert.equal(r.tables.pitches!.length, 1);
    assert.ok(r.ms < 4_500, `${r.ms} ms`);
  } finally {
    warn.mock.restore();
  }
});

test("stage: rewrite with an angle records against the rewritten pitch, kept draft only", async () => {
  const { result, rpcCalls } = await stage({ rewrite: true });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(rpcCalls.map((c) => [c.args.p_source, c.args.p_fact, c.args.p_pitch_id, c.args.p_pain_code]), [
    ["writer", "writer wish from draft three", EXISTING_PITCH, "lead_response_time"],
    ["critic", "critic wish from draft three", EXISTING_PITCH, "lead_response_time"],
  ]);
});

test("stage: the no_benchmark arm records nothing (the library was hidden on purpose); the decision keeps the wish", async () => {
  const hidden = await stage({ arm: "no_benchmark", leadPainBenchmark: true });
  assert.equal(hidden.result.ok, true, hidden.result.error);
  assert.equal(hidden.rpcCalls.length, 0, "a wish in the hidden arm is not a library gap");
  assert.deepEqual(hidden.resolved, [], "no pain lookup either");
  const decision = hidden.tables.pitches![0]!.decision as DecisionRecord;
  assert.equal(decision.wanted_fact, "writer wish from draft three");
  assert.equal(decision.arms?.["writer.evidence"], "no_benchmark");
  assert.deepEqual(decision.benchmarks_offered, []);

  // Control: same library, benchmark arm → recorded.
  const shown = await stage({ arm: "benchmark", leadPainBenchmark: true });
  assert.equal(shown.rpcCalls.length, 2);
});
