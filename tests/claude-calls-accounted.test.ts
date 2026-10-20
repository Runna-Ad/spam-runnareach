/**
 * Every paid Claude call outside lib/pitches/ reaches cost_tracking, failed
 * calls included (brief: tasks/briefs/claude-calls-accounted.md). The daily cap
 * (isUnderDailyCap) only sums those rows, so a call that never records is spend
 * the cap cannot see.
 *
 * Drives the real call sites with the real lib/anthropic/client.ts (its SDK
 * client swapped through __test__.setClient, so structuredCall really parses,
 * validates and prices the fake answer). Every other value import of a target
 * is stubbed by a loader hook ("@/" aliases, next/*, server-only modules node
 * cannot load here) and routed to globalThis.__stubs; recordClaudeCall is one
 * of those stubs and collects the rows.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import type { Actor } from "../lib/actor.ts";
import type * as T_client from "../lib/anthropic/client.ts";
import type * as T_snap_contact from "../lib/research/snap-contact.ts";
import type * as T_score_stage from "../lib/research/score-stage.ts";
import type * as T_suggest_action from "../lib/icp/suggest-action.ts";
import type * as T_gary_action from "../lib/icp/gary-action.ts";
import type * as T_send_reply_action from "../lib/replies/send-reply-action.ts";
import type * as T_route from "../app/api/replies/nudge/route.ts";
import type * as T_claude_search from "../lib/discover/sources/claude-search.ts";

const at = (p: string) => new URL(`../${p}`, import.meta.url).href;

const TARGET_FILES = [
  "lib/research/snap-contact.ts",
  "lib/research/scoring/claude-scorer.ts",
  "lib/research/score-stage.ts",
  "lib/icp/suggest-action.ts",
  "lib/icp/gary-action.ts",
  "lib/replies/send-reply-action.ts",
  "app/api/replies/nudge/route.ts",
  "lib/discover/sources/claude-search.ts",
];
// Imports that load for real (they have no imports node cannot resolve).
const REAL_ALIAS: Record<string, string> = {
  "@/lib/anthropic/client": at("lib/anthropic/client.ts"),
  "@/lib/research/email-utils": at("lib/research/email-utils.ts"),
  "@/lib/runna/capabilities": at("lib/runna/capabilities.ts"),
  "@/lib/prospects/status": at("lib/prospects/status.ts"),
};
const REAL_FILES = new Set([
  at("lib/research/scoring/rubric.ts"),
  at("lib/research/scoring/claude-scorer.ts"),
  at("lib/icp/option-sources.ts"),
  at("lib/discover/fuzzy-dedupe.ts"),
]);

// target href → import spec → value names it imports (type-only names dropped).
const IMPORTS: Record<string, Record<string, string[]>> = {};
for (const file of TARGET_FILES) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const bySpec: Record<string, string[]> = {};
  for (const [, kind, names, spec] of src.matchAll(/^import (type )?\{([^}]*)\} from "([^"]+)";/gm)) {
    if (kind) continue;
    const values = names!
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n && !n.startsWith("type "))
      .map((n) => n.split(/\s+as\s+/).pop()!);
    bySpec[spec!] = [...(bySpec[spec!] ?? []), ...values];
  }
  IMPORTS[at(file)] = bySpec;
}

const hooks = `
const IMPORTS = ${JSON.stringify(IMPORTS)};
const REAL_ALIAS = ${JSON.stringify(REAL_ALIAS)};
const REAL_FILES = new Set(${JSON.stringify([...REAL_FILES])});
export async function resolve(spec, ctx, next) {
  const imports = IMPORTS[ctx.parentURL];
  if (!imports || spec === "zod") return next(spec, ctx);
  if (spec in REAL_ALIAS) return { url: REAL_ALIAS[spec], shortCircuit: true };
  if (spec.startsWith(".")) {
    const href = new URL(spec.endsWith(".ts") ? spec : spec + ".ts", ctx.parentURL).href;
    if (REAL_FILES.has(href)) return { url: href, shortCircuit: true };
  }
  return { url: "stub:" + JSON.stringify(imports[spec] ?? []), shortCircuit: true };
}
export async function load(url, ctx, next) {
  if (!url.startsWith("stub:")) return next(url, ctx);
  const names = JSON.parse(url.slice(5));
  const src = names.map((n) =>
    "export const " + n + " = new Proxy(function () {}, {" +
    " apply: (_t, _s, a) => globalThis.__stub(" + JSON.stringify(n) + ")(...a)," +
    " get: (_t, k) => Reflect.get(globalThis.__stub(" + JSON.stringify(n) + "), k) });").join("\\n");
  return { format: "module", source: src, shortCircuit: true };
}`;
register("data:text/javascript," + encodeURIComponent(hooks));

// ── Stubs and fakes ──────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const stubs: Record<string, unknown> = {};
(globalThis as Record<string, unknown>).__stub = (name: string) => {
  if (!(name in stubs)) throw new Error(`no stub for ${name}`);
  return stubs[name];
};

let costRows: Row[] = [];

/** A permissive Supabase fake: every chain resolves to the table's rows. */
function fakeSupabase(tables: Record<string, Row[]>, writes: Row[] = [], failInserts: string[] = []) {
  const builder = (table: string) => {
    let single = false;
    let write: Row | null = null;
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ["select", "eq", "lt", "gt", "gte", "is", "not", "in", "order", "limit", "range", "returns"]) b[m] = chain;
    b.update = (v: Row) => { write = { table, op: "update", ...v }; return b; };
    b.insert = (v: Row) => { write = { table, op: "insert", ...v }; return b; };
    b.maybeSingle = () => { single = true; return b; };
    b.single = () => { single = true; return b; };
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
      if (write) writes.push(write);
      const rows = tables[table] ?? [];
      const data = write ? null : single ? (rows[0] ?? null) : rows;
      const error = write?.op === "insert" && failInserts.includes(table) ? { message: "insert failed" } : null;
      return Promise.resolve({ data, error, count: 0 }).then(ok, bad);
    };
    return b;
  };
  return { from: builder };
}

const ANTHROPIC = (await import(at("lib/anthropic/client.ts")) as typeof T_client);
const { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_HAIKU_MODEL, computeCostUsd, __test__ } = ANTHROPIC;

type Call = { model: string; system: { text: string }[]; messages: { content: string }[] };
const USAGE = { input_tokens: 1000, output_tokens: 100 };

/** Next SDK answer: a JSON value, raw text, or an Error to throw. */
function answerWith(reply: unknown, calls: Call[] = []): Call[] {
  __test__.setClient({
    messages: {
      create: async (input: Call) => {
        calls.push(input);
        if (reply instanceof Error) throw reply;
        const text = typeof reply === "string" ? reply : JSON.stringify(reply);
        return { content: [{ type: "text", text }], usage: USAGE };
      },
    },
  } as never);
  return calls;
}

const systemText = (c: Call | undefined) => (c?.system ?? []).map((b) => b.text).join("\n");

function reset() {
  costRows = [];
  for (const k of Object.keys(stubs)) delete stubs[k];
  Object.assign(stubs, {
    recordClaudeCall: async (row: Row) => { costRows.push(row); },
    isUnderDailyCap: async () => ({ under: true, spent_today_usd: 0, cap_usd: 3 }),
    revalidatePath: () => undefined,
    writeAuditLog: async () => undefined,
  });
  process.env.ANTHROPIC_API_KEY = "test-key";
}

test.afterEach(() => __test__.reset());

const quiet = <T>(fn: () => Promise<T>): Promise<T> => {
  const { error, warn, log } = console;
  console.error = console.warn = console.log = () => {};
  return fn().finally(() => Object.assign(console, { error, warn, log }));
};

// ── SnapVerify ───────────────────────────────────────────────────────────────

const SNAP = (await import(at("lib/research/snap-contact.ts")) as typeof T_snap_contact);
const NOTES = "About us: Ana Lopez founded Acme Studio in 2015 and runs it as owner.";

async function snapVerify(reply: unknown, calls: Call[] = []) {
  answerWith(reply, calls);
  const realFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sb.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  // Port 25 blocked → one probe, no greylisting retries.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ results: [], provider: "google", is_catch_all: false, port25_blocked: true, mx_host: null }))) as typeof fetch;
  try {
    return await quiet(() => SNAP.snapVerifyEnrich("p1", "acme.ca", NOTES, null, "Acme Studio"));
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("snapVerify: a successful extraction returns its usage, recorded as one research row with kind snap_verify", async () => {
  reset();
  const r = await snapVerify({ people: [{ full_name: "Ana Lopez", role_title: "Owner" }] });
  assert.equal(r.found, false);
  assert.ok(r.claudeCall, "the paid call is returned");
  assert.equal(r.claudeCall.fallback_reason, null);
  await SNAP.recordSnapVerifyCall("t1", "p1", r.claudeCall);
  assert.equal(costRows.length, 1);
  const row = costRows[0]!;
  assert.equal(row.entity_type, "research");
  assert.equal(row.entity_id, "p1");
  assert.equal(row.tenantId, "t1");
  assert.equal(row.model, ANTHROPIC_HAIKU_MODEL);
  assert.deepEqual(row.metadata, { kind: "snap_verify", prospect_id: "p1" });
  assert.equal((row.usage as { cost_usd: number }).cost_usd, computeCostUsd(ANTHROPIC_HAIKU_MODEL, 1000, 100));
});

test("snapVerify: a schema failure is still paid and still returned for recording", async () => {
  reset();
  const r = await snapVerify({ people: [{ full_name: "Ana Lopez" }] }); // role_title missing
  assert.equal(r.found, false);
  assert.ok(r.claudeCall);
  assert.equal(r.claudeCall.fallback_reason, "parse");
  assert.ok(r.claudeCall.usage.cost_usd > 0);
  await SNAP.recordSnapVerifyCall("t1", "p1", r.claudeCall);
  assert.equal(costRows.length, 1);
  assert.deepEqual(costRows[0]!.metadata, { kind: "snap_verify", prospect_id: "p1", fallback_reason: "parse" });
});

test("snapVerify: no call reached Claude (API error, too little text, social domain) → nothing to record", async () => {
  reset();
  assert.equal((await snapVerify(new Error("Connection error."))).claudeCall, null);
  const calls: Call[] = [];
  answerWith({ people: [] }, calls);
  assert.equal((await quiet(() => SNAP.snapVerifyEnrich("p1", "acme.ca", "short", null, "Acme"))).claudeCall, null);
  assert.equal((await SNAP.snapVerifyEnrich("p1", "facebook.com", NOTES, null, "Acme")).claudeCall, null);
  assert.equal(calls.length, 0);
});

test("snapVerify: the prompt names every key of the answer schema", async () => {
  reset();
  const calls: Call[] = [];
  await snapVerify({ people: [] }, calls);
  const prompt = systemText(calls[0]);
  for (const key of ["people", "full_name", "role_title"]) assert.match(prompt, new RegExp(`"${key}"`), key);
  assert.match(prompt, /null/);
});

// ── Scoring ──────────────────────────────────────────────────────────────────

const { scoreProspectWith } = (await import(at("lib/research/score-stage.ts")) as typeof T_score_stage);
const PID = "11111111-1111-4111-8111-111111111111";

function scoreActor(writes: Row[] = [], failInserts: string[] = []) {
  const supabase = fakeSupabase({
    prospects: [{ id: PID, industry: "fitness", city: null, region: null, country_code: "CA", employee_size_estimate: 10, red_flags: [], icp_id: null, icps: null }],
    prospect_research: [],
    prospect_contacts: [],
  }, writes, failInserts);
  return { supabase, user: { id: "u1", tenantId: "t1", role: "admin" } } as unknown as Actor;
}

const GOOD_SCORE = {
  composite_score: 60,
  breakdown: {
    industry_fit_pts: 15, size_fit_pts: 10, digital_maturity_pts: 10, pain_signal_pts: 5,
    service_match_pts: 8, contact_discoverability_pts: 2, geo_fit_pts: 10, red_flag_penalty: 0,
  },
  confidence: 0.7,
  reasoning: "Fits.",
};

test("score: a schema failure with usage records one scoring row with its real cost", async () => {
  reset();
  answerWith({ composite_score: 60 }); // no breakdown → schema failure, still billed
  const r = await quiet(() => scoreProspectWith(scoreActor(), PID));
  assert.ok(r.ok);
  assert.equal(r.method, "heuristic");
  assert.equal(costRows.length, 1);
  const row = costRows[0]!;
  assert.equal(row.entity_type, "scoring");
  assert.equal(row.entity_id, PID);
  assert.equal(row.model, ANTHROPIC_HAIKU_MODEL);
  assert.equal((row.usage as { cost_usd: number }).cost_usd, computeCostUsd(ANTHROPIC_HAIKU_MODEL, 1000, 100));
  assert.deepEqual(row.metadata, { fallback_reason: "parse" });
});

test("score: a successful call records exactly the row it recorded before (no metadata)", async () => {
  reset();
  answerWith(GOOD_SCORE);
  const r = await quiet(() => scoreProspectWith(scoreActor(), PID));
  assert.ok(r.ok);
  assert.equal(r.method, "claude");
  assert.equal(costRows.length, 1);
  assert.deepEqual(Object.keys(costRows[0]!).sort(), ["entity_id", "entity_type", "model", "tenantId", "usage"]);
});

test("score: the paid call is recorded even when the scores insert then fails", async () => {
  reset();
  answerWith(GOOD_SCORE);
  const r = await quiet(() => scoreProspectWith(scoreActor([], ["scores"]), PID));
  assert.equal(r.ok, false);
  assert.equal(costRows.length, 1);
  assert.equal(costRows[0]!.entity_type, "scoring");
});

test("score: heuristic-only runs record nothing (no key, over the cap, API error)", async () => {
  reset();
  delete process.env.ANTHROPIC_API_KEY;
  await quiet(() => scoreProspectWith(scoreActor(), PID));
  assert.equal(costRows.length, 0, "no API key");

  reset();
  stubs.isUnderDailyCap = async () => ({ under: false, spent_today_usd: 9, cap_usd: 3 });
  await quiet(() => scoreProspectWith(scoreActor(), PID));
  assert.equal(costRows.length, 0, "over the cap");

  reset();
  answerWith(new Error("Connection error."));
  const r = await quiet(() => scoreProspectWith(scoreActor(), PID));
  assert.ok(r.ok);
  assert.equal(r.method, "heuristic");
  assert.equal(costRows.length, 0, "API error: no usage");
});

// ── ICP refine + Gary ────────────────────────────────────────────────────────

const ICP_ID = "22222222-2222-4222-8222-222222222222";
const ICP = { id: ICP_ID, name: "Gyms", market: "CA", language: "en", industry_tags: [], business_types: [], search_keywords: [], excluded_keywords: [], employee_size_min: null, employee_size_max: null };
const EVIDENCE = {
  prospectCount: 6, researchedCount: 5, avgScore: 60,
  topPains: [], topTech: [], industriesPresent: [], whatTheyDoSamples: [], scoreReasoningSamples: [],
  runnaStrength: { caseStudyIndustries: [], coveredPains: [], services: [] },
};
const REFINE_KEYS = ["industry_tags", "business_types", "search_keywords", "excluded_keywords", "employee_size_min", "employee_size_max", "field_rationales", "summary"];

function icpStubs() {
  stubs.requireUser = async () => ({ id: "u1", tenantId: "t1", role: "admin" });
  stubs.createClient = async () => fakeSupabase({ icps: [ICP], services: [], case_studies: [] });
  stubs.gatherIcpEvidence = async () => EVIDENCE;
}

const { refineIcpFromEvidenceAction } = (await import(at("lib/icp/suggest-action.ts")) as typeof T_suggest_action);

test("icp refine: success and schema failure each record one icp_suggest row; an API error records none", async () => {
  reset(); icpStubs();
  const good = Object.fromEntries(REFINE_KEYS.map((k) => [k, k.startsWith("employee") ? null : k === "field_rationales" ? {} : k === "summary" ? "s".repeat(1200) : []]));
  const calls = answerWith(good);
  const ok = await quiet(() => refineIcpFromEvidenceAction(ICP_ID));
  assert.equal(ok.method, "claude", "a long summary is clipped, not a failure");
  assert.equal(ok.summary.length, 800);
  assert.equal(costRows.length, 1);
  assert.equal(costRows[0]!.entity_type, "icp_suggest");
  assert.equal(costRows[0]!.entity_id, ICP_ID);
  const prompt = systemText(calls[0]);
  for (const key of REFINE_KEYS) assert.match(prompt, new RegExp(`"${key}"`), key);
  for (const limit of ["12", "60", "240", "800"]) assert.match(prompt, new RegExp(`\\b${limit}\\b`), limit);

  reset(); icpStubs();
  answerWith({ summary: "x" });
  const bad = await quiet(() => refineIcpFromEvidenceAction(ICP_ID));
  assert.equal(bad.method, "heuristic");
  assert.equal(costRows.length, 1);
  assert.equal((costRows[0]!.metadata as Row).fallback_reason, "parse");
  assert.ok((costRows[0]!.usage as { cost_usd: number }).cost_usd > 0);

  reset(); icpStubs();
  answerWith(new Error("Connection error."));
  await quiet(() => refineIcpFromEvidenceAction(ICP_ID));
  assert.equal(costRows.length, 0);
});

const { garyBuildIcpAction } = (await import(at("lib/icp/gary-action.ts")) as typeof T_gary_action);

test("gary: a failed Sonnet call records once with the model actually called; an API error records none", async () => {
  reset(); icpStubs();
  const calls = answerWith({ phase: "question" }); // missing message/questions
  const r = await quiet(() => garyBuildIcpAction([]));
  assert.equal(r.phase, "error");
  assert.equal(calls[0]!.model, ANTHROPIC_DEFAULT_MODEL);
  assert.equal(costRows.length, 1);
  const row = costRows[0]!;
  assert.equal(row.entity_type, "icp_suggest");
  assert.equal(row.model, ANTHROPIC_DEFAULT_MODEL);
  assert.equal(row.tenantId, "t1");
  assert.equal((row.metadata as Row).fallback_reason, "parse");
  assert.equal((row.usage as { cost_usd: number }).cost_usd, computeCostUsd(ANTHROPIC_DEFAULT_MODEL, 1000, 100));

  reset(); icpStubs();
  answerWith(new Error("Connection error."));
  await quiet(() => garyBuildIcpAction([]));
  assert.equal(costRows.length, 0);
});

// ── Replies ──────────────────────────────────────────────────────────────────

const REPLY_ID = "33333333-3333-4333-8333-333333333333";
const PAID_FAILURE = { ok: false, error: "Schema validation failed", reason: "parse", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0.02 } };

function replyStubs(compose: unknown) {
  stubs.requireUser = async () => ({ id: "u1", tenantId: "t1", role: "admin" });
  stubs.senderIdentity = () => ({ firstName: "Pedro", agency: "Runna" });
  stubs.composeReplyDraftWithClaude = async () => compose;
  stubs.composeReplyDraftHeuristic = () => ({ body: "b", subject: "s" });
  stubs.createServiceRoleClient = () => fakeSupabase({
    replies: [{ id: REPLY_ID, tenant_id: "t1", prospect_id: PID, pitch_id: null, subject: "Re", body_text: "We went with someone else, too pricey.", intent: "not_now", received_at: "2026-10-01" }],
    prospects: [{ company_name: "Acme", language: "en" }],
    prospect_research: [],
    pitches: [],
  });
}

const REPLY = (await import(at("lib/replies/send-reply-action.ts")) as typeof T_send_reply_action);

test("reply draft regenerate: a paid failure records once, with the composer's model", async () => {
  reset(); replyStubs(PAID_FAILURE);
  const r = await REPLY.regenerateReplyDraft({ reply_id: REPLY_ID });
  assert.equal(r.ok, true);
  assert.equal(costRows.length, 1);
  assert.equal(costRows[0]!.entity_type, "reply_draft");
  assert.equal(costRows[0]!.model, ANTHROPIC_DEFAULT_MODEL);
  assert.deepEqual(costRows[0]!.metadata, { reply_id: REPLY_ID, source: "manual_regenerate", fallback_reason: "parse" });

  reset(); replyStubs({ ...PAID_FAILURE, usage: null });
  await REPLY.regenerateReplyDraft({ reply_id: REPLY_ID });
  assert.equal(costRows.length, 0, "no usage → nothing reached Claude");
});

test("no-meeting reason: a paid failure records once; a 600-char reason is clipped to 300 and kept", async () => {
  reset(); replyStubs(null);
  answerWith({ reason: "short" }); // under the 10-char floor → schema failure
  await REPLY.archiveNoMeeting({ prospect_id: PID, reply_id: REPLY_ID });
  assert.equal(costRows.length, 1);
  assert.deepEqual(costRows[0]!.metadata, { purpose: "no_meeting_reason", fallback_reason: "parse" });

  reset();
  const writes: Row[] = [];
  replyStubs(null);
  const base = stubs.createServiceRoleClient as () => ReturnType<typeof fakeSupabase>;
  stubs.createServiceRoleClient = () => {
    const sb = base();
    return { from: (t: string) => { const b = sb.from(t); const upd = b.update as (v: Row) => unknown; b.update = (v: Row) => { writes.push({ t, ...v }); return upd(v); }; return b; } };
  };
  const calls = answerWith({ reason: "r".repeat(600) });
  await REPLY.archiveNoMeeting({ prospect_id: PID, reply_id: REPLY_ID });
  assert.equal(costRows.length, 1);
  assert.equal(costRows[0]!.metadata && (costRows[0]!.metadata as Row).fallback_reason, undefined);
  const archived = writes.find((w) => w.t === "prospects");
  assert.equal(archived?.no_meeting_reason, "r".repeat(300));
  assert.match(systemText(calls[0]), /300 characters/);
});

const { GET: nudgeGet } = (await import(at("app/api/replies/nudge/route.ts")) as typeof T_route);

function nudgeStubs(compose: unknown) {
  process.env.CRON_SECRET = "s";
  Object.assign(stubs, {
    NextResponse: { json: (body: unknown) => body },
    createServiceRoleClient: () => fakeSupabase({
      replies: [{ id: REPLY_ID, tenant_id: "t1", prospect_id: PID, pitch_id: "pi1", from_email: "ana@acme.ca", subject: "Re", body_text: "hi", draft_sent_at: "2026-10-01" }],
      prospects: [{ id: PID, company_name: "Acme", language: "en", status: "replied", reply_attempts: 0, last_nudge_at: null, cooldown_until: null }],
      pitches: [{ subject: "Hi", body_edited: null, body_original: "b", sender_inbox_id: "in1" }],
      prospect_research: [],
      sender_inboxes: [{ id: "in1", email: "p@runna.ca", paused: false, gmail_refresh_token_encrypted: "x", sends_today: 0, last_reset_date: null, daily_cap: 10 }],
    }),
    effectiveSendsToday: () => 0,
    isEmailOnDncList: async () => ({ blocked: false }),
    getOutboundCompliance: () => ({ ok: true }),
    senderIdentity: () => ({ firstName: "Pedro", agency: "Runna" }),
    composeNudgeWithClaude: async () => compose,
    composeNudgeHeuristic: () => ({ body: "b", subject: "s" }),
    loadGateContext: async () => null,
    utcToday: () => "2026-10-20",
  });
}

test("nudge: a paid failure records once and the draft is held; no usage records nothing", async () => {
  reset(); nudgeStubs(PAID_FAILURE);
  const req = { headers: { get: () => "Bearer s" } };
  const out = await nudgeGet(req as never) as unknown as { results: { action: string }[] };
  assert.equal(out.results[0]?.action, "held_for_review");
  assert.equal(costRows.length, 1);
  assert.equal(costRows[0]!.model, ANTHROPIC_DEFAULT_MODEL);
  assert.equal(costRows[0]!.entity_type, "reply_draft");
  assert.deepEqual(costRows[0]!.metadata, { prospect_id: PID, source: "nudge", attempt: 1, fallback_reason: "parse" });

  reset(); nudgeStubs({ ...PAID_FAILURE, usage: null });
  await nudgeGet(req as never);
  assert.equal(costRows.length, 0);
});

// ── Classifier and research: display text is clipped, never fatal ────────────

test("classifier: a 1,000-character reasoning classifies (clipped to 400) instead of failing", async () => {
  reset();
  const { classifyReplyWithClaude } = await import("../lib/replies/claude-classifier.ts");
  const text = JSON.stringify({ intent: "wants_meeting", urgency: "hot", sentiment: "positive", reasoning: "x".repeat(1000) });
  // Like the API, cut the answer at max_tokens (~4 chars a token for this text).
  __test__.setClient({
    messages: {
      create: async (i: { max_tokens: number }) =>
        ({ content: [{ type: "text", text: text.slice(0, i.max_tokens * 4) }], usage: USAGE }),
    },
  } as never);
  const r = await classifyReplyWithClaude({ subject: "Re", body_text: "Let's talk Tuesday", from_email: "a@b.co" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.result.classification.intent, "wants_meeting");
    assert.equal(r.result.classification.reasoning.length, 400);
  }
});

test("research: a long reasoning is clipped; pain_label's 200 limit is in the prompt", async () => {
  reset();
  const { runResearchWithClaude } = await import("../lib/research/claude-research.ts");
  const calls = answerWith({ pain_points: [], decision_maker_email: null, reasoning: "y".repeat(1200) });
  const r = await runResearchWithClaude({
    what_they_do: "A gym.", notes: null,
    options: [{ id: "44444444-4444-4444-8444-444444444444", slug: "slow_site", display_name: "Slow site", description: null }],
    existingPainIds: [],
  } as never);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.result.reasoning.length, 800);
  assert.match(systemText(calls[0]), /pain_label[^\n]*200/);
});

// ── ICP "Suggest with AI" (suggestIcpFieldsAction) ───────────────────────────

const { suggestIcpFieldsAction } = (await import(at("lib/icp/suggest-action.ts")) as typeof T_suggest_action);
const SUGGEST_INPUT = {
  name: "Gyms", market: "CA" as const, language: "en" as const,
  existing: { industry_tags: [], business_types: [], geo_regions: [], google_places_types: [], search_keywords: [], excluded_keywords: [] },
};

test("icp suggest fields: no session → heuristic only, no Claude call, no row", async () => {
  reset();
  stubs.requireUser = async () => { throw new Error("Not authenticated"); };
  stubs.suggestIcpFields = () => ({ heuristic: true });
  const calls = answerWith({});
  const r = await quiet(() => suggestIcpFieldsAction(SUGGEST_INPUT as never));
  assert.deepEqual(r, { heuristic: true });
  assert.equal(calls.length, 0);
  assert.equal(costRows.length, 0);
});

test("icp suggest fields: a logged-in call records one icp_suggest row priced like lib/anthropic, even if unparseable", async () => {
  reset();
  stubs.requireUser = async () => ({ id: "u1", tenantId: "t1", role: "viewer" });
  stubs.suggestIcpFields = () => ({ heuristic: true });
  const calls = answerWith("not json at all");
  await quiet(() => suggestIcpFieldsAction(SUGGEST_INPUT as never));
  assert.equal(calls.length, 1);
  assert.equal(costRows.length, 1);
  const row = costRows[0]!;
  assert.equal(row.entity_type, "icp_suggest");
  assert.equal(row.tenantId, "t1");
  assert.equal(row.model, ANTHROPIC_HAIKU_MODEL);
  assert.deepEqual(row.metadata, { kind: "icp_suggest_fields" });
  assert.equal((row.usage as { cost_usd: number }).cost_usd, computeCostUsd(ANTHROPIC_HAIKU_MODEL, 1000, 100));

  reset();
  stubs.requireUser = async () => ({ id: "u1", tenantId: "t1", role: "admin" });
  stubs.suggestIcpFields = () => ({ heuristic: true });
  answerWith(new Error("Connection error."));
  await quiet(() => suggestIcpFieldsAction(SUGGEST_INPUT as never));
  assert.equal(costRows.length, 0, "API error: nothing was billed");
});

// ── AI Search discovery source (searchWithClaude) ────────────────────────────

const { searchWithClaude } = (await import(at("lib/discover/sources/claude-search.ts")) as typeof T_claude_search);

/** N tool-use turns, then either a final JSON answer or an API error. */
function searchTurns(toolTurns: number, end: "answer" | "error") {
  let n = 0;
  __test__.setClient({
    messages: {
      create: async () => {
        n++;
        if (n <= toolTurns) {
          return {
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: `tu${n}`, name: "brave_search", input: { query: `gyms ${n}` } }],
            usage: USAGE,
          };
        }
        if (end === "error") throw new Error("Connection error.");
        return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ businesses: [] }) }], usage: USAGE };
      },
    },
  } as never);
}

test("ai search: every paid turn records one research row (kind ai_search); a turn that errors records none", async () => {
  for (const [toolTurns, end, rows] of [[2, "answer", 3], [3, "error", 3], [0, "answer", 1]] as const) {
    reset();
    stubs.braveIsAvailable = () => true;
    stubs.searchBrave = async () => ({ ok: true, listings: [] });
    stubs.normalizeDomain = (d: string) => d;
    searchTurns(toolTurns, end);
    const r = await quiet(() => searchWithClaude({ tenantId: "t1", brief: "gyms", location: "Calgary" }));
    const at_ = `${toolTurns} tool turns, then ${end}`;
    assert.equal(r.ok, end === "answer", at_);
    assert.equal(costRows.length, rows, at_);
    costRows.forEach((row, i) => {
      assert.equal(row.entity_type, "research", at_);
      assert.equal(row.entity_id, null, at_);
      assert.equal(row.tenantId, "t1", at_);
      assert.equal(row.model, ANTHROPIC_DEFAULT_MODEL, at_);
      assert.deepEqual(row.metadata, { kind: "ai_search", turn: i }, at_);
      assert.equal((row.usage as { cost_usd: number }).cost_usd, computeCostUsd(ANTHROPIC_DEFAULT_MODEL, 1000, 100), at_);
    });
  }
});
