/**
 * Brief tasks/briefs/pitch-rewrite-notes.md, the stage side. Drives the real
 * generatePitchWith and suggestPitchAnglesAction against a fake Supabase
 * client; every value import is stubbed by a loader hook (they use "@/"
 * aliases and next/*), except lib/prospects/status.ts (the real predicate),
 * zod, and lib/pitches/review.ts's WRITER_FIXABLE / revisionIssues /
 * NOT_REVIEWED_ISSUE, which the stubs hand over from the real module.
 * Same harness shape as tests/pipeline-guards.test.ts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { DO_NOT_SEND_STATUSES } from "../lib/prospects/status.ts";
import { NOT_REVIEWED_ISSUE, WRITER_FIXABLE, composeWithReview, revisionIssues } from "../lib/pitches/review.ts";
import { PITCH_PROMPT_VERSION, heldBodyForRevision } from "../lib/pitches/claude-composer.ts";
import { DECISION_VERSION } from "../lib/pitches/decision.ts";
import { __test__ } from "../lib/anthropic/client.ts";

const PITCH_URL = new URL("../lib/pitches/pitch-stage.ts", import.meta.url);
const ANGLE_URL = new URL("../lib/pitches/angle-advisor.ts", import.meta.url);
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
const TARGETS = { [PITCH_URL.href]: stubNames(PITCH_URL), [ANGLE_URL.href]: stubNames(ANGLE_URL) };

// Constants the stage compares against (a Proxy is never === a string): the
// stub module exports the real values for these names.
(globalThis as Record<string, unknown>).__rwConsts = { NOT_REVIEWED_ISSUE, WRITER_FIXABLE, PITCH_PROMPT_VERSION, DECISION_VERSION, ANTHROPIC_DEFAULT_MODEL: "sonnet-x" };
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
  const src = names.map((n) => CONSTS.includes(n) ? "export const " + n + " = globalThis.__rwConsts." + n + ";" : "export const " + n + " = new Proxy(function () {}, { apply: (_t, _s, a) => globalThis.__rwStubs." + n + "(...a), get: (_t, k) => { const v = globalThis.__rwStubs." + n + "; const f = v[k]; return typeof f === 'function' ? f.bind(v) : f; } });").join("\\n");
  return { format: "module", source: src, shortCircuit: true };
}`;
register("data:text/javascript," + encodeURIComponent(hooks));

// ── Fake Supabase ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Db = {
  tables: Record<string, Row[]>;
  /** Tables whose SELECTs fail with this postgrest-shaped error. */
  failSelects?: Record<string, { message: string }>;
  log: string[];
};
type Result = { data: unknown; error: { message: string } | null };

class Query implements PromiseLike<Result> {
  private op: "select" | "update" | "insert" | "delete" = "select";
  private values: Row = {};
  private one = false;
  private filters: ((r: Row) => boolean)[] = [];
  private db: Db;
  private table: string;
  constructor(db: Db, table: string) { this.db = db; this.table = table; }
  select() { return this; }
  update(v: Row) { this.op = "update"; this.values = v; return this; }
  insert(v: Row) { this.op = "insert"; this.values = v; return this; }
  delete() { this.op = "delete"; return this; }
  eq(k: string, v: unknown) { this.filters.push((r) => r[k] === v); return this; }
  in(k: string, v: unknown[]) { this.filters.push((r) => v.includes(r[k])); return this; }
  gte() { return this; }
  order() { return this; }
  private lim: number | null = null;
  limit(n: number) { this.lim = n; return this; }
  returns() { return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }
  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, bad);
  }
  private run(): Result {
    this.db.log.push(`${this.op}:${this.table}`);
    const rows = (this.db.tables[this.table] ??= []);
    if (this.op === "insert") {
      const row = { id: `new-${rows.length}`, ...this.values };
      rows.push(row);
      return { data: this.one ? { ...row } : [{ ...row }], error: null };
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "select") {
      if (this.db.failSelects?.[this.table]) return { data: null, error: this.db.failSelects[this.table]! };
      const out = (this.lim === null ? hit : hit.slice(0, this.lim)).map((r) => ({ ...r }));
      return { data: this.one ? (out[0] ?? null) : out, error: null };
    }
    if (this.op === "delete") for (const r of hit) rows.splice(rows.indexOf(r), 1);
    else for (const r of hit) Object.assign(r, this.values);
    return { data: null, error: null };
  }
}

function stub(impl: Record<string, unknown>, calls: string[]) {
  (globalThis as Record<string, unknown>).__rwStubs = new Proxy(impl, {
    get(t, name: string) {
      const f = t[name];
      if (f === undefined) throw new Error(`no stub for ${name}`);
      if (typeof f !== "function") return f;
      return (...a: unknown[]) => { calls.push(name); return f(...a); };
    },
  });
}

const USER = { id: "u1", tenantId: "t1", role: "admin" };
const PROSPECT_ID = "00000000-0000-4000-8000-000000000001";
const HELD_ID = "00000000-0000-4000-8000-0000000000aa";
const REACHED = "compose-reached";
const OLD_LINK = "https://runna-hunter.vercel.app/?market=ca&r=OLD123";
const NEW_LINK = "https://runna-hunter.vercel.app/?market=ca&r=code";
const FWD_EN = "If you're not the right person for this, I'd really appreciate it if you could pass this along to whoever handles it.";

// ── generatePitchWith ────────────────────────────────────────────────────────

type Held = Partial<{ subject: string; body_original: string; body_edited: string | null; decision: unknown; gate_verdict: unknown; tenant_id: string; prospect_id: string }>;

function claudeHeld(over: Held = {}): Row {
  return {
    id: HELD_ID, tenant_id: "t1", prospect_id: PROSPECT_ID, status: "draft",
    subject: "clinica sur loses patients at night",
    body_original: `Hi Ana,\n\nMost of your traffic is mobile now.\n\n👉 See it for yourself: ${OLD_LINK}\n\nHenry\nRunna Advertising\n\n${FWD_EN}`,
    body_edited: null,
    decision: {
      path: "claude",
      critic: {
        pass: false, score: 0.6,
        issues: ["Inference stated as fact: 'Most of your traffic is mobile now'", "(polish) subject is long"],
      },
    },
    gate_verdict: {
      version: 2, pass: false, checked_at: "x",
      failures: [
        { code: "unverified_recipient", severity: "review", detail: "Recipient not verified" },
        { code: "unsourced_metric", severity: "block", detail: 'Unsourced number "three seconds"' },
        { code: "banned_jargon", severity: "review", detail: 'Banned word "leads"' },
      ],
    },
    ...over,
  };
}

async function run(opts: {
  status?: string;
  held?: Row | null;
  failHeldRead?: boolean;
  retryOf?: string | null;
  clock?: { now: number; composeMs: number };
  /** Run the real write → review loop (SDK mocked) instead of the throwing stub. */
  realCompose?: boolean;
  roleInbox?: boolean;
  /** The prospect's contacts (default: one, Ana) and the recipient rule's pick (default: the first usable). */
  contacts?: Row[];
  pick?: (rows: Row[]) => Row | null;
}) {
  const calls: string[] = [];
  const composerContacts: unknown[] = [];
  const seen: Array<{ reviseFirst: unknown; deadline: number; startedAt: number; heldStillThere: boolean }> = [];
  const db: Db = {
    tables: {
      prospects: [{
        id: PROSPECT_ID, tenant_id: "t1", company_name: "Clinica Sur", industry: null, language: "en",
        employee_size_estimate: 5, city: null, market: null, domain: "clinicasur.ca", website_url: null,
        status: opts.status ?? "pitched",
      }],
      prospect_research: opts.realCompose
        ? [{ tenant_id: "t1", prospect_id: PROSPECT_ID, what_they_do: "family dental clinic", tech_stack: [], pain_points: [{ pain_id: "p1", pain_label: "Lead response time", evidence_quote: "contact form only, no online booking" }] }]
        : [],
      prospect_contacts: opts.contacts ?? [opts.roleInbox
        ? { tenant_id: "t1", prospect_id: PROSPECT_ID, email: "info@clinicasur.ca", email_is_role_based: true, full_name: null, role_title: null, priority_rank: 1 }
        : { tenant_id: "t1", prospect_id: PROSPECT_ID, email: "ana@clinicasur.ca", email_is_role_based: false, full_name: "Ana", role_title: null, priority_rank: 1 }],
      case_studies: [],
      pitches: opts.held ? [opts.held] : [],
    },
    failSelects: opts.failHeldRead ? { pitches: { message: "" } } : undefined,
    log: [],
  };
  let startedAt = 0;
  stub({
    revalidatePath: () => undefined,
    claudeIsAvailable: () => true,
    isUnderDailyCap: async () => ({ under: true, spent_today_usd: 0, cap_usd: 3 }),
    recordClaudeCall: async () => undefined,
    writeAuditLog: async () => undefined,
    hasUsableEmail: (e: unknown) => typeof e === "string" && e.includes("@"),
    isRoleBasedEmail: () => false,
    listNotableClients: async () => [],
    fetchBenchmarksForPitch: async () => [],
    chooseWriterArms: async () => ({ evidence: "benchmark", guidance: null }),
    fetchExemplars: async () => [],
    segmentOf: () => "seg",
    newAttributionCode: () => "code",
    senderForGenerator: () => ({ name: "Henry" }),
    buildHunterUrlForPitch: () => NEW_LINK,
    heldBodyForRevision,
    fetchTopUsableContact: async () => null,
    chooseRecipient: (rows: Row[] | null) =>
      opts.pick ? opts.pick(rows ?? []) : (rows?.find((c) => typeof c.email === "string" && c.email.includes("@")) ?? null),
    refreshGateAfterChange: async () => null,
    sizeBand: () => "smb",
    registerFor: () => "tu",
    recipientSummary: () => null,
    detectCitedBenchmark: () => null,
    decisionExemplarFields: () => ({}),
    recordPitchEvent: async () => undefined,
    renderIndustryTemplate: (_i: unknown, why: string) => { throw new Error(`template reached: ${why}`); },
    revisionIssues,
    composeWithReview: async (input: Parameters<typeof composeWithReview>[0], o: Parameters<typeof composeWithReview>[1]) => {
      composerContacts.push(input.contacts);
      if (opts.realCompose) return composeWithReview(input, o);
      seen.push({
        reviseFirst: o.reviseFirst,
        deadline: o.deadline,
        startedAt,
        heldStillThere: (db.tables.pitches ?? []).some((p) => p.id === HELD_ID),
      });
      if (opts.clock) opts.clock.now += opts.clock.composeMs;
      throw new Error(REACHED);
    },
  }, calls);
  const supabase = { from: (t: string) => new Query(db, t) };
  const { generatePitchWith } = await import(PITCH_URL.href);
  const realNow = Date.now;
  if (opts.clock) {
    const c = opts.clock;
    Date.now = () => c.now;
    startedAt = c.now;
  }
  let result: { ok: boolean; error?: string } | null = null;
  let thrown: unknown = null;
  try {
    result = await generatePitchWith({ supabase, user: USER }, PROSPECT_ID, opts.retryOf === null ? {} : { retryOf: opts.retryOf ?? HELD_ID });
  } catch (e) {
    thrown = e;
  } finally {
    Date.now = realNow;
  }
  return { result, thrown, seen, calls, log: db.log, db, composerContacts };
}

test("rewrite of a Claude draft: the first compose revises it with its notes, gate details first, max 8", async () => {
  const { seen, thrown } = await run({ held: claudeHeld() });
  assert.equal((thrown as Error).message, REACHED);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.heldStillThere, true, "the held draft is read before it is deleted");
  assert.deepEqual(seen[0]!.reviseFirst, {
    subject: "clinica sur loses patients at night",
    // The old link back to the slot (its r= code belongs to the held row), no forwarding line.
    body: "Hi Ana,\n\nMost of your traffic is mobile now.\n\n👉 See it for yourself: {hunter_url}\n\nHenry\nRunna Advertising",
    issues: [
      // Writing findings only (the recipient check is not the writer's), gate first.
      'Unsourced number "three seconds"',
      'Banned word "leads"',
      "Inference stated as fact: 'Most of your traffic is mobile now'",
      "(polish) subject is long",
    ],
  });
});

test("rewrite: at most 8 notes; the 'not reviewed' sentinel is not a note", async () => {
  const many = Array.from({ length: 10 }, (_, i) => `critic note ${i}`);
  const { seen } = await run({ held: claudeHeld({ decision: { path: "claude", critic: { issues: [...many, NOT_REVIEWED_ISSUE] } } }) });
  const r = seen[0]!.reviseFirst as { issues: string[] };
  assert.equal(r.issues.length, 8);
  assert.deepEqual(r.issues.slice(0, 2), ['Unsourced number "three seconds"', 'Banned word "leads"']);
  assert.ok(!r.issues.includes(NOT_REVIEWED_ISSUE));
});

test("rewrite falls back to a fresh compose: template, no notes, read error, gone, other tenant or prospect", async () => {
  const cases: Array<[string, Parameters<typeof run>[0]]> = [
    ["template", { held: claudeHeld({ decision: { path: "template", critic: null } }) }],
    ["edited by a person", { held: claudeHeld({ body_edited: "Hi Ana, my own words." }) }],
    ["no critic, gate passed", { held: claudeHeld({ decision: { path: "claude", critic: null }, gate_verdict: { pass: true, failures: [] } }) }],
    ["only the not-reviewed sentinel", { held: claudeHeld({ decision: { path: "claude", critic: { issues: [NOT_REVIEWED_ISSUE] } }, gate_verdict: null }) }],
    ["read error (empty-body 5xx)", { held: claudeHeld(), failHeldRead: true }],
    ["row gone", { held: null }],
    ["other tenant", { held: claudeHeld({ tenant_id: "t2" }) }],
    ["other prospect", { held: claudeHeld({ prospect_id: "00000000-0000-4000-8000-000000000002" }) }],
  ];
  for (const [label, o] of cases) {
    const { seen, thrown } = await run(o);
    assert.equal((thrown as Error).message, REACHED, label);
    assert.equal(seen.length, 1, label);
    assert.equal(seen[0]!.reviseFirst, undefined, label);
  }
});

test("a first draft (no retryOf) never reads a held draft and composes exactly as before", async () => {
  const { seen, log } = await run({ held: claudeHeld(), retryOf: null });
  assert.equal(seen[0]!.reviseFirst, undefined);
  assert.ok(!log.includes("select:pitches"), "no pitches read on a first draft");
});

test("deadline: two rewrites in one tick each get startedAt + 48 s (fake clock)", async () => {
  const clock = { now: 5_000_000, composeMs: 46_000 };
  const a = await run({ held: claudeHeld(), clock });
  const b = await run({ held: claudeHeld(), clock });
  for (const [label, r] of [["first", a], ["second", b]] as const) {
    assert.equal(r.seen.length, 1, label);
    assert.equal(r.seen[0]!.deadline - r.seen[0]!.startedAt, 48_000, label);
    assert.ok(r.seen[0]!.reviseFirst, label);
  }
  assert.ok(b.seen[0]!.startedAt >= a.seen[0]!.deadline - 2_000, "the second rewrite starts after the first");
});

const FRESH_BODY = `Hi Clinica Sur team,\n\nHenry from Runna Advertising here. Right now the only way to reach Clinica Sur online is a contact form.\n\n👉 Run Clinica Sur through our free check, about 30 seconds: {hunter_url}\n\nHenry\nRunna Advertising`;

/** A writer that echoes the previous draft it was handed (the worst case), or writes FRESH_BODY; a critic that passes. */
function echoWriter() {
  __test__.setClient({
    messages: {
      create: async (r: { system?: { text: string }[] | string; messages: { content: string }[] }) => {
        const sys = typeof r.system === "string" ? r.system : (r.system ?? []).map((b) => b.text).join("\n");
        const text = sys.includes("You review a cold email")
          ? JSON.stringify({ score: 0.95, issues: [] })
          : JSON.stringify({
              subject: "contact form only at clinica sur",
              preview_text: "the only way in after hours is a contact form",
              body: /Previous draft:\nSubject: [^\n]*\n([\s\S]*?)\n+```json/.exec(r.messages[0]!.content)?.[1]?.trim() ?? FRESH_BODY,
              pain_id: null, contact_email: "info@clinicasur.ca", measurable_result_included: false, quality_self_score: 0.8, reasoning: "x",
            });
        return { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } };
      },
    },
  } as never);
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";
}

test("full path: a writer that keeps the held 👉 line ends with the NEW attribution code, the forwarding line once, retry_mode revised", async () => {
  echoWriter();
  const { result, db, thrown } = await run({ held: claudeHeld(), realCompose: true, roleInbox: true });
  assert.equal(thrown, null, String((thrown as Error)?.stack));
  assert.equal(result?.ok, true, result?.error);
  const pitches = db.tables.pitches!;
  assert.equal(pitches.some((p) => p.id === HELD_ID), false, "the held draft is replaced");
  const created = pitches.find((p) => p.id !== HELD_ID)!;
  const body = String(created.body_original);
  assert.ok(body.includes(NEW_LINK), body);
  assert.doesNotMatch(body, /OLD123/);
  assert.equal(body.split(FWD_EN).length - 1, 1, "forwarding line exactly once");
  assert.equal(created.attribution_code, "code");
  const decision = created.decision as { retry_of?: string; retry_mode?: string; prompt_version?: string };
  assert.equal(decision.retry_of, HELD_ID);
  assert.equal(decision.retry_mode, "revised");
  assert.equal(decision.prompt_version, PITCH_PROMPT_VERSION);
});

test("full path: a template held draft is rewritten fresh and says so (retry_mode fresh)", async () => {
  echoWriter();
  const { result, db } = await run({ held: claudeHeld({ decision: { path: "template", critic: null } }), realCompose: true });
  assert.equal(result?.ok, true, result?.error);
  const created = db.tables.pitches!.find((p) => p.id !== HELD_ID)!;
  assert.equal((created.decision as { retry_mode?: string }).retry_mode, "fresh");
});

test("guard: an emailed company (sent, replied, bounced, ghosted) is refused before any Claude call", async () => {
  for (const status of ["sent", "replied", "bounced", "ghosted", ...DO_NOT_SEND_STATUSES]) {
    const { result, thrown, seen } = await run({ status, held: claudeHeld() });
    assert.equal(thrown, null, status);
    assert.equal(seen.length, 0, status);
    assert.equal(result?.ok, false, status);
    assert.match(result?.error ?? "", new RegExp(`company is ${status}`), status);
  }
});

test("guard: a drafted-but-unsent company (pitched, queued, approved) still gets its rewrite", async () => {
  for (const status of ["pitched", "queued", "approved"]) {
    const { seen } = await run({ status, held: claudeHeld() });
    assert.equal(seen.length, 1, status);
  }
});

// ── The recipient (redraft-pool): the text greets the contact the pitch is linked to ──

const person = (id: string, rank: number, email: string | null, full_name: string | null): Row => ({
  id, tenant_id: "t1", prospect_id: PROSPECT_ID, email, email_is_role_based: false, full_name, role_title: null, priority_rank: rank,
  selected_by: "scraper", verify_verdict: null, verify_checked_at: null,
});
const asComposer = (rows: Row[]) =>
  rows.map((c) => ({ full_name: c.full_name, email: c.email, email_is_role_based: false, role_title: null }));

test("recipient: the rule's usual pick leaves the composer's contacts exactly the top five, as before", async () => {
  const six = [person("n", 0, null, "Name Only"), person("a", 1, "ana@clinicasur.ca", "Ana"), person("b", 2, "bo@clinicasur.ca", "Bo"),
    person("c", 3, "cy@clinicasur.ca", "Cy"), person("d", 4, "di@clinicasur.ca", "Di"), person("e", 5, "ed@clinicasur.ca", "Ed")];
  const { composerContacts } = await run({ held: null, retryOf: null, contacts: six });
  assert.deepEqual(composerContacts, [asComposer(six.slice(0, 5))]);
});

test("recipient: a contact chosen past a flagged one leads the list and is the pitch's contact_id", async () => {
  echoWriter();
  const rows = [person("a", 1, "ana@clinicasur.ca", "Ana"), person("b", 2, "bo@clinicasur.ca", "Bo")];
  const { result, db, composerContacts } = await run({
    held: null, retryOf: null, realCompose: true, contacts: rows, pick: (r) => r.find((c) => c.id === "b") ?? null,
  });
  assert.equal(result?.ok, true, result?.error);
  assert.deepEqual(composerContacts[0], asComposer([rows[1]!, rows[0]!]));
  const created = db.tables.pitches!.find((p) => p.id !== HELD_ID)!;
  assert.equal(created.contact_id, "b");
});

test("recipient: no usable contact in the top five is refused as before, whatever the rule picks", async () => {
  const rows = [0, 1, 2, 3, 4].map((i) => person(`n${i}`, i, null, `N${i}`)).concat(person("f", 9, "fa@clinicasur.ca", "Fa"));
  const { result, composerContacts } = await run({ held: null, retryOf: null, contacts: rows, pick: (r) => r.find((c) => c.id === "f") ?? null });
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? "", /No contact email/);
  assert.equal(composerContacts.length, 0);
});

test("recipient: a rewrite to another contact composes fresh; to the same contact it revises as before", async () => {
  const rows = [person("a", 1, "ana@clinicasur.ca", "Ana"), person("b", 2, "bo@clinicasur.ca", "Bo")];
  const toBo = (r: Row[]) => r.find((c) => c.id === "b") ?? null;
  const moved = await run({ held: claudeHeld({ contact_id: "a" } as Held), contacts: rows, pick: toBo });
  assert.equal(moved.seen[0]!.reviseFirst, undefined, "the held text greets Ana; Bo gets a fresh draft");
  const same = await run({ held: claudeHeld({ contact_id: "b" } as Held), contacts: rows, pick: toBo });
  assert.notEqual(same.seen[0]!.reviseFirst, undefined);
});

// ── suggestPitchAnglesAction records its Claude call ──────────────────────────

async function angles(mode: "ok" | "parse" | "no_usage") {
  const calls: string[] = [];
  const recorded: Array<Record<string, unknown>> = [];
  const usage = { input_tokens: 300, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0.0007 };
  const db: Db = {
    tables: {
      prospects: [{ id: PROSPECT_ID, tenant_id: "t1", company_name: "Clinica Sur", industry: "clinic", employee_size_estimate: 5, language: "en" }],
      prospect_research: [{ prospect_id: PROSPECT_ID, pain_points: [{ pain_id: "p1", pain_label: "Slow replies", evidence_quote: "form only", confidence: 0.7 }] }],
      case_studies: [],
      services: [],
      pain_taxonomy: [],
    },
    log: [],
  };
  stub({
    ANTHROPIC_HAIKU_MODEL: "haiku-x",
    claudeIsAvailable: () => true,
    structuredCall: async () =>
      mode === "ok"
        ? { ok: true, data: { rationales: [{ index: 0, rationale: "Lead with slow replies." }] }, usage, raw: "{}", model: "haiku-x" }
        : mode === "parse"
          ? { ok: false, error: "Schema validation failed", usage, reason: "parse" }
          : { ok: false, error: "timed out", usage: null, reason: "timeout" },
    recordClaudeCall: async (r: Record<string, unknown>) => { recorded.push(r); },
    requireUser: async () => USER,
    createClient: async () => ({ from: (t: string) => new Query(db, t) }),
    RUNNA_CAPABILITIES: "caps",
  }, calls);
  const { suggestPitchAnglesAction } = await import(ANGLE_URL.href);
  const result = await suggestPitchAnglesAction(PROSPECT_ID);
  return { result, recorded, usage };
}

test("angle advice: a successful call is recorded once, as a pitch call of kind angle_advice", async () => {
  const { result, recorded, usage } = await angles("ok");
  assert.equal(result.method, "claude");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.entity_type, "pitch");
  assert.equal(recorded[0]!.entity_id, null);
  assert.equal(recorded[0]!.tenantId, "t1");
  assert.deepEqual(recorded[0]!.usage, usage);
  assert.equal((recorded[0]!.metadata as Record<string, unknown>).kind, "angle_advice");
});

test("angle advice: a failed call that spent tokens is recorded once too, and the advisor still answers", async () => {
  const { result, recorded, usage } = await angles("parse");
  assert.equal(result.method, "heuristic");
  assert.equal(recorded.length, 1);
  const meta = recorded[0]!.metadata as Record<string, unknown>;
  assert.equal(meta.kind, "angle_advice");
  assert.equal(meta.ok, false);
  assert.equal(meta.reason, "parse");
  assert.deepEqual(recorded[0]!.usage, usage);
});

test("angle advice: a call that never reached the API (usage null) records nothing", async () => {
  const { result, recorded } = await angles("no_usage");
  assert.equal(result.method, "heuristic");
  assert.equal(recorded.length, 0);
});
