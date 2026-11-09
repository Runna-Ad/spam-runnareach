/**
 * web-dive: one dive's outcome mapping (ok / empty / failed for a timeout,
 * pause_turn, an unparseable answer, search disabled), cost on usage, and the
 * run's budget (< $0.50 left, a cap read error, 25 dives in 24h, the time
 * budget). Fake Claude responses in the shape of the web_search server tool.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { WEB_FACT_KINDS } from "../lib/research/web-dive/facts.ts";
import { runDive, WEB_DIVE_MAX_USES, WEB_DIVE_SYSTEM, webDiveUserPrompt, type DiveOutcome, type DiveProspect, type WebDiveCostInput } from "../lib/research/web-dive/dive.ts";
import {
  budgetStop,
  CALL_TIMEOUT_MS,
  DB_TIMEOUT_MS,
  DIVES_PER_RUN,
  HEARTBEAT_MS,
  MAX_DIVES_PER_24H,
  MIN_CAP_LEFT_USD,
  MIN_REMAINING_TO_START_MS,
  ROUTE_MAX_DURATION_S,
  RUN_DEADLINE_MS,
  runWebDives,
  type CapState,
  type RunDeps,
} from "../lib/research/web-dive/run.ts";
import type { DueDive } from "../lib/research/web-dive/store.ts";

const PROSPECT: DiveProspect = {
  id: "p1",
  tenant_id: "t1",
  company_name: "CrushCamp Inc.",
  city: "Calgary",
  region: "AB",
  country_code: "CA",
  domain: "crushcamp.ca",
  website_url: "https://crushcamp.ca",
  industry: "fitness studio",
};
const YELP = "https://www.yelp.ca/biz/crushcamp-calgary";
const RESULTS = [{ url: YELP, title: "CrushCamp - Calgary, AB - Yelp" }];
const CITATIONS = [{ url: YELP, cited_text: "Love the coaches, but I called three times and nobody ever answered the phone." }];
const GOOD = { fact: "A Yelp reviewer says nobody ever answered the phone.", quote: "nobody ever answered the phone", url: YELP, kind: "problem" };
const BAD = { fact: "CrushCamp has 900 members.", quote: "CrushCamp has 900 members in Calgary", url: YELP, kind: "context" };
const USAGE = { input_tokens: 50_000, output_tokens: 1_500, server_tool_use: { web_search_requests: 4 } };
// Built at run time: a key-shaped string in the source trips the secret scanners.
const FAKE_KEY = ["sk", "ant", "api03", "A".repeat(28)].join("-");

const json = (facts: unknown[]) => `Here is what I found.\n\`\`\`json\n${JSON.stringify({ facts, no_facts_reason: facts.length ? null : "nothing about this business" })}\n\`\`\``;

function response(o: { text?: string; results?: typeof RESULTS; citations?: typeof CITATIONS; stop?: string; usage?: unknown; searchError?: string } = {}) {
  return {
    stop_reason: o.stop ?? "end_turn",
    ...(o.usage === null ? {} : { usage: o.usage ?? USAGE }),
    content: [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "CrushCamp Calgary reviews" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "s1",
        content: o.searchError
          ? { type: "web_search_tool_result_error", error_code: o.searchError }
          : (o.results ?? RESULTS).map((r) => ({ type: "web_search_result", url: r.url, title: r.title, encrypted_content: "x" })),
      },
      {
        type: "text",
        text: "A reviewer says nobody ever answered the phone.",
        citations: (o.citations ?? CITATIONS).map((c) => ({ type: "web_search_result_location", url: c.url, title: "t", cited_text: c.cited_text, encrypted_index: "e" })),
      },
      { type: "text", text: o.text ?? json([GOOD, BAD]) },
    ],
  };
}

async function dive(answer: unknown | (() => Promise<unknown>)) {
  const costs: WebDiveCostInput[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const o = await runDive(
    PROSPECT,
    {
      create: async (params) => {
        requests.push(params);
        return typeof answer === "function" ? (answer as () => Promise<unknown>)() : answer;
      },
      recordCost: async (c) => void costs.push(c),
      model: "claude-sonnet-4-5-20250929",
    },
    { researchId: "r1" },
  );
  return { o, costs, requests };
}

// ── One dive ─────────────────────────────────────────────────────────────────

test("ok: one kept, one dropped with its reason; cost recorded once, as web_research, on the claimed row", async () => {
  const { o, costs, requests } = await dive(response());
  assert.equal(o.status, "ok");
  assert.equal(o.facts.length, 1);
  assert.equal(o.facts[0]!.quote, GOOD.quote);
  assert.deepEqual(o.dropped.map((d) => d.reason), ["quote_not_in_citation"]);
  assert.equal(o.searches, 4);
  assert.equal(o.error, null);
  assert.equal(costs.length, 1);
  assert.equal(costs[0]!.entity_type, "web_research");
  assert.equal(costs[0]!.entity_id, "r1");
  assert.equal(costs[0]!.tenantId, "t1");
  // Tokens plus $0.01 a search (researchCost).
  assert.ok(o.costUsd !== null && o.costUsd > 0.04 && o.costUsd < 0.5, String(o.costUsd));
  assert.equal(costs[0]!.usage.cost_usd, o.costUsd);
  const req = requests[0]!;
  assert.deepEqual(req.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_DIVE_MAX_USES }]);
  assert.equal(WEB_DIVE_MAX_USES, 4);
  assert.equal(req.model, "claude-sonnet-4-5-20250929");
});

test("empty: the search ran and nothing was kept (no facts, or every candidate dropped); cost still recorded", async () => {
  const none = await dive(response({ text: json([]) }));
  assert.equal(none.o.status, "empty");
  assert.deepEqual(none.o.facts, []);
  assert.equal(none.costs.length, 1);
  const allDropped = await dive(response({ text: json([BAD]) }));
  assert.equal(allDropped.o.status, "empty");
  assert.equal(allDropped.o.dropped.length, 1);
  // A search that returned no results is still a search that ran.
  const noResults = await dive(response({ results: [], citations: [], text: json([]) }));
  assert.equal(noResults.o.status, "empty");
});

test("failed: a timeout or any thrown call error (nothing paid, nothing recorded); the key is redacted", async () => {
  const t = await dive(async () => {
    throw new Error("Request timed out.");
  });
  assert.equal(t.o.status, "failed");
  assert.match(t.o.error ?? "", /^call failed: Request timed out/);
  assert.equal(t.costs.length, 0);
  assert.equal(t.o.searchDisabled, false);
  const k = await dive(async () => {
    throw new Error(`401 invalid x-api-key ${FAKE_KEY}`);
  });
  assert.ok(!(k.o.error ?? "").includes(FAKE_KEY));
  assert.match(k.o.error ?? "", /\[REDACTED\]/);
});

test("failed: pause_turn, an unparseable or wrong-shape answer; each paid call still recorded", async () => {
  const p = await dive(response({ stop: "pause_turn" }));
  assert.equal(p.o.status, "failed");
  assert.match(p.o.error ?? "", /pause_turn/);
  assert.equal(p.costs.length, 1);
  for (const text of ["I could not find anything.", "```json\n{\"facts\": [oops\n```", "```json\n{\"facts\": \"none\"}\n```"]) {
    const u = await dive(response({ text }));
    assert.equal(u.o.status, "failed", text);
    assert.match(u.o.error ?? "", /JSON/, text);
    assert.equal(u.costs.length, 1, text);
    assert.deepEqual(u.o.facts, []);
  }
});

test("failed: web search disabled (thrown or as a result error) sets searchDisabled; no search ran or search errors only also fail", async () => {
  const d = await dive(async () => {
    throw new Error("400 web search is not enabled for this organization");
  });
  assert.equal(d.o.status, "failed");
  assert.equal(d.o.searchDisabled, true);
  const d2 = await dive(response({ searchError: "web search tool is disabled for this organization" }));
  assert.equal(d2.o.status, "failed");
  assert.equal(d2.o.searchDisabled, true);
  const none = await dive({
    stop_reason: "end_turn",
    usage: { input_tokens: 900, output_tokens: 40 },
    content: [{ type: "text", text: json([]) }],
  });
  assert.equal(none.o.status, "failed");
  assert.equal(none.o.error, "no search ran");
  const errs = await dive(response({ searchError: "too_many_requests", usage: { input_tokens: 900, output_tokens: 40, server_tool_use: { web_search_requests: 1 } } }));
  assert.equal(errs.o.status, "failed");
  assert.match(errs.o.error ?? "", /search errors: too_many_requests/);
  assert.equal(errs.o.searchDisabled, false);
});

test("a malformed candidate is dropped as malformed, the rest still checked", async () => {
  const { o } = await dive(response({ text: json([{ fact: 3 }, GOOD]) }));
  assert.equal(o.status, "ok");
  assert.deepEqual(o.dropped.map((d) => d.reason), ["malformed"]);
});

test("prompt: name, place, domain and industry; the three kinds; never their own site; no em dashes in it", () => {
  const u = webDiveUserPrompt(PROSPECT);
  for (const s of ["CrushCamp Inc.", "Calgary, AB, CA", "crushcamp.ca", "fitness studio"]) assert.ok(u.includes(s), s);
  for (const k of WEB_FACT_KINDS) assert.ok(WEB_DIVE_SYSTEM.includes(`"${k}"`), k);
  assert.match(WEB_DIVE_SYSTEM, /other than its own website/);
  assert.match(WEB_DIVE_SYSTEM, /"No facts" is a good, useful answer/);
  assert.match(WEB_DIVE_SYSTEM, /Never guess/);
  assert.doesNotMatch(WEB_DIVE_SYSTEM + u, /[—–]/);
  assert.equal(
    webDiveUserPrompt({ ...PROSPECT, city: null, region: null, country_code: null, industry: null, domain: null }),
    "Business: CrushCamp Inc.\nIts own website (do not use it): https://crushcamp.ca",
  );
});

// ── The run's budget ─────────────────────────────────────────────────────────

const due = (n: number): DueDive => ({ ...PROSPECT, id: `p${n}`, research_id: `r${n}` });
const outcome = (status: DiveOutcome["status"], over: Partial<DiveOutcome> = {}): DiveOutcome => ({
  status, facts: [], dropped: [], searches: 4, costUsd: 0.21, model: "m", error: status === "failed" ? "x" : null, searchDisabled: false, ...over,
});

function harness(o: { queue?: DueDive[]; cap?: CapState; started?: { count: number } | { error: string }; outcomes?: DiveOutcome[]; diveMs?: number } = {}) {
  const queue = [...(o.queue ?? [due(1), due(2), due(3)])];
  const log: string[] = [];
  let t = 0;
  const deps: RunDeps = {
    claim: async () => {
      const d = queue.shift();
      log.push(d ? `claim ${d.research_id}` : "claim none");
      return d ? [d] : [];
    },
    capState: async () => o.cap ?? { spentUsd: 1, capUsd: 5 },
    startedLast24h: async (_tenant, exclude) => {
      log.push(`count excl ${exclude}`);
      return o.started ?? { count: 3 };
    },
    release: async (id) => {
      log.push(`release ${id}`);
      return { ok: true };
    },
    dive: async (d) => {
      log.push(`dive ${d.research_id}`);
      t += o.diveMs ?? 20_000;
      return (o.outcomes ?? []).shift() ?? outcome("ok");
    },
    save: async (id, out) => {
      log.push(`save ${id} ${out.status}`);
      return { ok: true };
    },
    now: () => t,
  };
  return { deps, log, run: () => runWebDives(deps, 0) };
}

test("run: two dives a run at most, each claimed, counted, dived and saved", async () => {
  const h = harness();
  const r = await h.run();
  assert.equal(DIVES_PER_RUN, 2);
  assert.equal(r.dived, 2);
  assert.equal(r.saved, 2);
  assert.equal(r.stopped, null);
  assert.deepEqual(h.log, ["claim r1", "count excl r1", "dive r1", "save r1 ok", "claim r2", "count excl r2", "dive r2", "save r2 ok"]);
  assert.equal(r.costUsd, 0.42);
});

test("budget: less than $0.50 left under the cap gives the claim back and stops the run", async () => {
  for (const cap of [{ spentUsd: 4.51, capUsd: 5 }, { spentUsd: 5.2, capUsd: 5 }, { spentUsd: Number.NaN, capUsd: 5 }]) {
    const h = harness({ cap });
    const r = await h.run();
    assert.equal(r.stopped, "cap", JSON.stringify(cap));
    assert.equal(r.dived, 0);
    assert.equal(r.released, 1);
    assert.deepEqual(h.log, ["claim r1", "count excl r1", "release r1"]);
    assert.match(r.stopDetail ?? "", /AI budget/);
  }
  // Exactly $0.50 left is enough.
  assert.equal(budgetStop({ spentUsd: 4.5, capUsd: 5 }, { count: 0 }), null);
  assert.equal(MIN_CAP_LEFT_USD, 0.5);
});

test("budget: a cap read error is 'do not dive' (never fail-open)", async () => {
  const h = harness({ cap: { error: "cost read failed: " } });
  const r = await h.run();
  assert.equal(r.stopped, "cap_read");
  assert.equal(r.dived, 0);
  assert.equal(r.released, 1);
});

test("budget: 25 dives started in 24h stops the run; a count error does too", async () => {
  assert.equal(MAX_DIVES_PER_24H, 25);
  const full = await harness({ started: { count: 25 } }).run();
  assert.equal(full.stopped, "daily_limit");
  assert.equal(full.dived, 0);
  const ok = await harness({ started: { count: 24 } }).run();
  assert.equal(ok.dived, 2);
  const err = await harness({ started: { error: "web_research count failed: " } }).run();
  assert.equal(err.stopped, "count_read");
  assert.equal(err.dived, 0);
});

test("time: the second dive starts only with 55 s left before the 105 s deadline; past it the run stops before claiming", async () => {
  const slow = harness({ diveMs: 51_000 });
  const r = await slow.run();
  assert.equal(r.dived, 1);
  assert.equal(r.stopped, "deadline");
  assert.deepEqual(slow.log, ["claim r1", "count excl r1", "dive r1", "save r1 ok"]);
  const fast = await harness({ diveMs: 50_000 }).run();
  assert.equal(fast.dived, 2);
});

test("time: claimed, but the budget reads ran past the start line: the claim goes back unused", async () => {
  let t = 0;
  const h = harness();
  h.deps.capState = async () => {
    t = 51_000;
    return { spentUsd: 0, capUsd: 5 };
  };
  h.deps.now = () => t;
  const r = await h.run();
  assert.equal(r.dived, 0);
  assert.equal(r.released, 1);
  assert.equal(r.stopped, "deadline");
});

test("search disabled stops the run after that dive; nothing due says so; a failed save is an error", async () => {
  const off = await harness({ outcomes: [outcome("failed", { searchDisabled: true })] }).run();
  assert.equal(off.dived, 1);
  assert.equal(off.stopped, "search_disabled");
  const none = await harness({ queue: [] }).run();
  assert.equal(none.stopped, "none_due");
  assert.equal(none.claimed, 0);
  const h = harness();
  h.deps.save = async () => ({ ok: false, error: "row no longer pending (swept as abandoned)" });
  const r = await h.run();
  assert.equal(r.saved, 0);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0]!, /not saved \(row no longer pending/);
});

test("a dive that throws is saved as failed (never left pending); a failing first claim fails the run, a later one is an error", async () => {
  const h = harness();
  h.deps.dive = async () => {
    throw new Error("bug");
  };
  const r = await h.run();
  assert.deepEqual(h.log.filter((l) => l.startsWith("save")), ["save r1 failed", "save r2 failed"]);
  assert.equal(r.outcomes.failed, 2);
  const first = harness();
  first.deps.claim = async () => {
    throw new Error("claim_web_research: empty error");
  };
  await assert.rejects(first.run(), /claim_web_research/);
  const later = harness();
  let n = 0;
  const claim = later.deps.claim;
  later.deps.claim = async () => {
    if (n++ === 1) throw new Error("claim_web_research: timeout");
    return claim();
  };
  const r2 = await later.run();
  assert.equal(r2.dived, 1);
  assert.match(r2.errors[0] ?? "", /^claim: claim_web_research: timeout/);
});

test("time budget at the worst case: two dives that each hang to the client timeout end before maxDuration", () => {
  // Dive 1: claim + the budget reads (cap and count, each bounded) + the call + the save.
  const first = DB_TIMEOUT_MS + DB_TIMEOUT_MS + CALL_TIMEOUT_MS + DB_TIMEOUT_MS;
  assert.ok(first <= RUN_DEADLINE_MS);
  // Dive 2's call starts only with MIN_REMAINING_TO_START_MS left before RUN_DEADLINE_MS.
  const second = RUN_DEADLINE_MS - MIN_REMAINING_TO_START_MS + CALL_TIMEOUT_MS + DB_TIMEOUT_MS;
  assert.ok(second + HEARTBEAT_MS < ROUTE_MAX_DURATION_S * 1000, `${second + HEARTBEAT_MS} ms`);
  assert.equal(CALL_TIMEOUT_MS, 50_000);
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as { functions: Record<string, { maxDuration: number }> };
  const keys = Object.keys(vercel.functions);
  // Vercel uses the FIRST matching pattern: the route's own entry must come before app/**.
  const at = keys.indexOf("app/api/research/web-dive/route.ts");
  assert.ok(at >= 0 && at < keys.indexOf("app/**"));
  assert.equal(vercel.functions["app/api/research/web-dive/route.ts"]!.maxDuration, ROUTE_MAX_DURATION_S);
});
