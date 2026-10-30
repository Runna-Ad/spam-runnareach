/**
 * The observe run (lib/research/site-crawl/observe.ts, budget.ts, psi.ts,
 * store.ts) and migration 0054: the time budget at the designed load, PageSpeed
 * with and without a key, what is saved, and the schedule.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CRON_JOBS, cronsOf } from "../lib/reports/heartbeat.ts";
import { scheduledRuns } from "../lib/reports/health.ts";
import { DO_NOT_SEND_STATUSES } from "../lib/prospects/status.ts";
import {
  CLAIM_TIMEOUT_MS,
  DESIGNED_PROSPECTS_PER_DAY,
  HEARTBEAT_MS,
  plan,
  PSI_TIMEOUT_MS,
  ROUTE_BUDGET_MS,
  ROUTE_MAX_DURATION_S,
  RUNS_PER_WEEKDAY,
  SAVE_TIMEOUT_MS,
  SITES_PER_RUN,
} from "../lib/research/site-crawl/budget.ts";
import { crawlSite, SITE_BUDGET_MS } from "../lib/research/site-crawl/crawl.ts";
import { unseenChecks } from "../lib/research/site-crawl/detectors.ts";
import type { FetchPage } from "../lib/research/site-crawl/fetch-page.ts";
import { observeBatch, psiFor, type DueSite, type ObserveDeps } from "../lib/research/site-crawl/observe.ts";
import { makeRunPsi, psiRequestUrl, reducePsi, type PsiOutcome } from "../lib/research/site-crawl/psi.ts";
import { ALLOW_ALL } from "../lib/research/site-crawl/robots.ts";
import { claimDueSites, observationRow, saveObservation, type ObservationsDb } from "../lib/research/site-crawl/store.ts";
import { CRAWLER_VERSION, type SiteObservation } from "../lib/research/site-crawl/types.ts";

const sql = readFileSync(new URL("../supabase/migrations/0054_site_observations.sql", import.meta.url), "utf8");
const code = sql.replace(/--.*$/gm, "");
const t = (iso: string) => new Date(iso).getTime();

const due = (n: number): DueSite[] =>
  Array.from({ length: n }, (_, i) => ({ id: `obs-${i}`, tenant_id: "tenant-1", prospect_id: `p-${i}`, url: `https://site${i}.test/` }));

function observation(url: string, over: Partial<SiteObservation> = {}): SiteObservation {
  return {
    url,
    final_url: url,
    crawled_at: "2026-10-30T15:12:00.000Z",
    crawler_version: CRAWLER_VERSION,
    status: "ok",
    readable: { html: true, text: true, links: true },
    pages: [],
    checks: unseenChecks(),
    duration_ms: 1000,
    ...over,
  };
}

// ── Acceptance 3: budget at the designed load ────────────────────────────────

test("budget: 100 researched prospects a day fit the weekday schedule, with room for the backlog", () => {
  assert.equal(DESIGNED_PROSPECTS_PER_DAY, 100);
  // 16 runs a weekday is exactly what the migration's cron gives.
  const week = scheduledRuns([...cronsOf("site-observe")], t("2026-11-01T23:59:00Z"), t("2026-11-08T23:59:00Z"), 1000);
  assert.equal(week, RUNS_PER_WEEKDAY * 5);
  assert.equal(plan.callsPerWeek, 80);
  assert.equal(plan.weeklyLoad, 700);
  assert.ok(plan.weeklyCapacity >= plan.weeklyLoad, `${plan.weeklyCapacity} per week < ${plan.weeklyLoad}`);
  assert.equal(plan.weeklyCapacity, 960);
});

test("budget: worst case (every site and PageSpeed hanging to their timeouts) ends under maxDuration", () => {
  assert.equal(plan.worstCaseMs, CLAIM_TIMEOUT_MS + Math.max(SITE_BUDGET_MS, PSI_TIMEOUT_MS) + SAVE_TIMEOUT_MS + HEARTBEAT_MS);
  assert.ok(plan.worstCaseMs <= ROUTE_BUDGET_MS + HEARTBEAT_MS);
  // 12 s left for the cold start and the scheduler-token check.
  assert.ok(ROUTE_MAX_DURATION_S * 1000 - plan.worstCaseMs >= 10_000, `${plan.worstCaseMs} ms`);
});

test("budget: in a run, every timeout handed out ends before the save reserve, even when the claim was slow", async () => {
  let clock = 1_000_000;
  const start = clock;
  const handed: Array<{ what: string; at: number; ms: number }> = [];
  const deps: ObserveDeps = {
    now: () => clock,
    claim: async (limit, ms) => {
      handed.push({ what: "claim", at: clock, ms });
      clock += ms; // the claim used its whole timeout
      return due(limit);
    },
    crawl: async (url, opts) => {
      handed.push({ what: "crawl", at: clock, ms: opts.siteBudgetMs ?? -1 });
      return observation(url);
    },
    runPsi: async (url, ms) => {
      handed.push({ what: "psi", at: clock, ms });
      return { status: "timeout", result: null, error: `no answer in ${ms} ms` };
    },
    save: async (_s, _o, _p, ms) => {
      handed.push({ what: "save", at: clock, ms });
      return { ok: true };
    },
  };
  const report = await observeBatch(deps, start);
  assert.equal(report.claimed, SITES_PER_RUN);
  assert.equal(report.saved, SITES_PER_RUN);
  for (const h of handed.filter((x) => x.what === "crawl" || x.what === "psi")) {
    assert.ok(h.at + h.ms <= start + ROUTE_BUDGET_MS - SAVE_TIMEOUT_MS, `${h.what} ends at ${h.at + h.ms - start}`);
  }
  assert.ok(handed.some((h) => h.what === "psi" && h.ms === PSI_TIMEOUT_MS), "PSI gets its full timeout after a 5 s claim");
  assert.deepEqual(report.psi, { timeout: SITES_PER_RUN }, "PageSpeed timing out still saves the crawl");
});

test("budget: real crawlSite with every page hanging stops inside the site budget it is given", async () => {
  let clock = 0;
  const hang: FetchPage = async (_url, ms) => {
    clock += ms;
    return { ok: false, status: null, finalUrl: null, error: "timeout", detail: `no answer in ${ms} ms` };
  };
  const obs = await crawlSite("https://slow.test/", { fetchPage: hang, fetchRobots: async () => ALLOW_ALL, now: () => clock, siteBudgetMs: SITE_BUDGET_MS });
  assert.ok(clock <= SITE_BUDGET_MS, `${clock} ms`);
  assert.equal(obs.status, "unreachable");
});

// ── Acceptance 4: no key ─────────────────────────────────────────────────────

test("no PAGESPEED_API_KEY: psi_status 'no_key', no request, the crawl is still saved, no error", async () => {
  let requests = 0;
  const runPsi = makeRunPsi(undefined, (async () => {
    requests++;
    throw new Error("must not be called");
  }) as unknown as typeof fetch);
  const saved: Array<Record<string, unknown>> = [];
  const report = await observeBatch(
    {
      claim: async () => due(2),
      crawl: async (url) => observation(url),
      runPsi,
      save: async (_site, obs, psi) => {
        saved.push(observationRow(obs, psi));
        return { ok: true };
      },
    },
    Date.now(),
  );
  assert.equal(requests, 0);
  assert.equal(report.saved, 2);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.psi, { no_key: 2 });
  assert.ok(saved.every((r) => r.psi_status === "no_key" && r.psi === null && r.status === "ok"));
});

test("an empty claim does nothing; a crawler bug leaves the row pending (swept later) and is reported", async () => {
  const none = await observeBatch({ claim: async () => [], runPsi: makeRunPsi(null), save: async () => ({ ok: true }) }, Date.now());
  assert.deepEqual(none, { claimed: 0, saved: 0, statuses: {}, psi: {}, errors: [] });
  let saves = 0;
  const bug = await observeBatch(
    {
      claim: async () => due(2),
      crawl: async (url) => {
        if (url.includes("site0")) throw new Error("boom");
        return observation(url);
      },
      runPsi: makeRunPsi(null),
      save: async () => {
        saves++;
        return { ok: true };
      },
    },
    Date.now(),
  );
  assert.equal(saves, 1);
  assert.equal(bug.saved, 1);
  assert.match(bug.errors[0] ?? "", /p-0: crawl threw \(boom\)/);
});

// ── PageSpeed ────────────────────────────────────────────────────────────────

const PSI_BODY = {
  lighthouseResult: {
    finalDisplayedUrl: "https://www.lodge.test/",
    categories: { performance: { score: 0.42 }, seo: { score: 0.91 }, accessibility: { score: 0.8 }, "best-practices": { score: 0.74 } },
    audits: {
      "largest-contentful-paint": { numericValue: 5321.7 },
      "cumulative-layout-shift": { numericValue: 0.12345 },
      "total-blocking-time": { numericValue: 812.4 },
      "network-requests": {
        details: {
          items: [
            { url: "https://www.lodge.test/" },
            { url: "https://cdn.lodge.test/app.js" },
            { url: "https://lodge.checkfront.com/lib/interface.js" },
            { url: "https://www.googletagmanager.com/gtm.js?id=GTM-1" },
            { url: "https://connect.facebook.net/en_US/fbevents.js" },
            { url: "data:image/png;base64,xx" },
          ],
        },
      },
    },
  },
};

test("PSI is kept small: 4 scores, LCP, CLS, TBT and third-party hosts (not the site's own)", () => {
  const r = reducePsi(PSI_BODY, "https://lodge.test/", "2026-10-30T15:12:00.000Z");
  assert.deepEqual(r, {
    scores: { performance: 42, seo: 91, accessibility: 80, best_practices: 74 },
    lcp_ms: 5322,
    cls: 0.123,
    tbt_ms: 812,
    third_party_domains: ["connect.facebook.net", "googletagmanager.com", "lodge.checkfront.com"],
    final_url: "https://www.lodge.test/",
    fetched_at: "2026-10-30T15:12:00.000Z",
  });
  const empty = reducePsi({}, "https://lodge.test/");
  assert.deepEqual(empty.scores, { performance: null, seo: null, accessibility: null, best_practices: null });
});

test("PSI request: mobile, all four categories, the key only in the query", () => {
  const u = new URL(psiRequestUrl("https://lodge.test/", "KEY123"));
  assert.equal(u.origin + u.pathname, "https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  assert.equal(u.searchParams.get("strategy"), "mobile");
  assert.deepEqual(u.searchParams.getAll("category"), ["performance", "seo", "accessibility", "best-practices"]);
  assert.equal(u.searchParams.get("url"), "https://lodge.test/");
});

test("PSI outcomes: ok, HTTP error (message kept, key never), timeout", async () => {
  const okFetch = (async () => new Response(JSON.stringify(PSI_BODY), { status: 200 })) as unknown as typeof fetch;
  const ok = await makeRunPsi("KEY123", okFetch)("https://lodge.test/", 1000);
  assert.equal(ok.status, "ok");
  assert.equal(ok.result?.scores.performance, 42);

  const errFetch = (async () => new Response(JSON.stringify({ error: { message: "Lighthouse returned error: NO_FCP" } }), { status: 500 })) as unknown as typeof fetch;
  const err = await makeRunPsi("KEY123", errFetch)("https://lodge.test/", 1000);
  assert.deepEqual([err.status, err.error], ["error", "HTTP 500 Lighthouse returned error: NO_FCP"]);
  assert.ok(!JSON.stringify(err).includes("KEY123"));

  // AbortSignal.timeout's timer is unref'd: a ref'd timer keeps the test alive until the abort fires.
  const hangFetch = ((_u: string, init: RequestInit) =>
    new Promise((_, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("abort never fired")), 5_000);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal?.reason);
      });
    })) as unknown as typeof fetch;
  const slow = await makeRunPsi("KEY123", hangFetch)("https://lodge.test/", 20);
  assert.equal(slow.status, "timeout");
});

test("PSI result is dropped for a site we may not read (robots) or that is not theirs (offsite)", () => {
  const psi: PsiOutcome = { status: "ok", result: reducePsi(PSI_BODY, "https://lodge.test/"), error: null };
  assert.equal(psiFor(observation("https://x.test/", { status: "offsite" }), psi).status, "skipped");
  const robots = observation("https://x.test/", {
    status: "blocked",
    pages: [{ url: "https://x.test/", role: "home", http_status: null, title: null, text_chars: 0, links_seen: 0, readable: { html: false, text: false, links: false }, error: "robots.txt disallows it" }],
  });
  assert.equal(psiFor(robots, psi).status, "skipped");
  // A bot wall on our crawler is not a robots refusal: Google's measurement stands.
  assert.equal(psiFor(observation("https://x.test/", { status: "blocked" }), psi).status, "ok");
});

// ── Store ────────────────────────────────────────────────────────────────────

/** Columns of site_observations from the migration's create table. */
const COLUMNS = new Set(
  [...(/create table if not exists public\.site_observations \(([\s\S]*?)\n\);/.exec(code)?.[1] ?? "").matchAll(/^\s+([a-z_]+)\s+(uuid|text|timestamptz|jsonb|integer)/gm)].map((m) => m[1]),
);

function fakeDb(answer: { rows?: number; error?: { message: string } | null; rpc?: unknown }) {
  const calls: Array<{ table: string; values: Record<string, unknown>; filters: Array<[string, string]> }> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db: ObservationsDb = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { abortSignal: async () => ({ data: answer.rpc ?? [], error: answer.error ?? null }) };
    },
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        for (const k of Object.keys(values)) assert.ok(COLUMNS.has(k), `site_observations has no column ${k}`);
        const call = { table, values, filters: [] as Array<[string, string]> };
        calls.push(call);
        const chain = {
          eq: (col: string, v: string) => {
            assert.ok(COLUMNS.has(col), `site_observations has no column ${col}`);
            call.filters.push([col, v]);
            return chain;
          },
          select: () => ({
            abortSignal: async () => ({ data: answer.error ? null : Array.from({ length: answer.rows ?? 1 }, () => ({ id: "x" })), error: answer.error ?? null }),
          }),
        };
        return chain;
      },
    }),
  } as unknown as ObservationsDb;
  return { db, calls, rpcCalls };
}

test("save: updates only the still-pending claimed row, with columns the table has", async () => {
  assert.ok(COLUMNS.size >= 14, [...COLUMNS].join(","));
  const { db, calls } = fakeDb({ rows: 1 });
  const site = due(1)[0] as DueSite;
  const res = await saveObservation(db, site, observation(site.url), { status: "no_key", result: null, error: null }, 1000);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls[0]?.filters, [["id", "obs-0"], ["status", "pending"]]);
  assert.equal(calls[0]?.table, "site_observations");
});

test("save: a row the next run swept to 'abandoned' is not overwritten; an empty-message error is still an error", async () => {
  const site = due(1)[0] as DueSite;
  const swept = await saveObservation(fakeDb({ rows: 0 }).db, site, observation(site.url), { status: "no_key", result: null, error: null }, 1000);
  assert.equal(swept.ok, false);
  const empty = await saveObservation(fakeDb({ error: { message: "" } }).db, site, observation(site.url), { status: "no_key", result: null, error: null }, 1000);
  assert.deepEqual(empty, { ok: false, error: "empty error" });
  await assert.rejects(claimDueSites(fakeDb({ error: { message: "" } }).db, 12, CRAWLER_VERSION, 1000), /claim_site_observations/);
  const { db, rpcCalls } = fakeDb({ rpc: due(2) });
  assert.equal((await claimDueSites(db, 12, CRAWLER_VERSION, 1000)).length, 2);
  assert.deepEqual(rpcCalls[0], { fn: "claim_site_observations", args: { p_limit: 12, p_crawler_version: CRAWLER_VERSION } });
});

test("psi column: the reduced result, or { error } on a failure, or null", () => {
  const o = observation("https://x.test/");
  assert.deepEqual(observationRow(o, { status: "timeout", result: null, error: "no answer in 35000 ms" }).psi, { error: "no answer in 35000 ms" });
  assert.equal(observationRow(o, { status: "no_key", result: null, error: null }).psi, null);
});

// ── Migration 0054 ───────────────────────────────────────────────────────────

test("0054: table with RLS on, tenant read-only policy, claim function service-role only", () => {
  assert.match(code, /alter table public\.site_observations enable row level security/);
  assert.match(code, /create policy site_observations_tenant_read on public\.site_observations\s+for select/);
  assert.doesNotMatch(code, /create policy[^;]*for (all|insert|update|delete)\b/);
  assert.match(code, /revoke all on function public\.claim_site_observations\(integer, text\) from public, anon, authenticated/);
  assert.match(code, /grant execute on function public\.claim_site_observations\(integer, text\) to service_role/);
  assert.match(code, /idx_site_observations_latest\s+on public\.site_observations \(tenant_id, prospect_id, crawled_at desc\)/);
  assert.match(code, /unique index if not exists site_observations_one_pending\s+on public\.site_observations \(prospect_id\) where status = 'pending'/);
});

test("0054: no prospect twice in 30 days; skips exactly the do-not-send statuses; sweeps stale claims first", () => {
  assert.match(code, /o\.crawled_at > now\(\) - case when o\.status = 'abandoned' then interval '1 day' else interval '30 days' end/);
  const listed = /p\.status not in \(([^)]*)\)/.exec(code)?.[1]?.split(",").map((s) => s.trim().replace(/'/g, "")) ?? [];
  assert.deepEqual(listed.sort(), [...DO_NOT_SEND_STATUSES].sort());
  assert.ok(code.indexOf("set status = 'abandoned'") < code.indexOf("return query"), "sweep at the START of a run");
  assert.match(code, /order by pr\.last_scraped_at desc/);
  assert.match(code, /pr\.research_method = 'claude_assisted'/);
});

test("0054: the status and psi_status lists match the TypeScript unions", () => {
  const statuses = /check \(status in \(([^)]*)\)\)/.exec(code)?.[1]?.replace(/'|\s/g, "").split(",") ?? [];
  assert.deepEqual(statuses, ["pending", "ok", "unreachable", "blocked", "not_html", "too_large", "offsite", "abandoned"]);
  const psi = /check \(psi_status in \(([^)]*)\)\)/.exec(code)?.[1]?.replace(/'|\s/g, "").split(",") ?? [];
  assert.deepEqual(psi, ["ok", "no_key", "timeout", "error", "skipped"]);
});

test("0054: the weekday-window schedule is the one CRON_JOBS watches, and the header states calls/week and CPU", () => {
  assert.deepEqual(CRON_JOBS["site-observe"], {
    route: "/api/research/observe",
    schedules: [{ pgJob: "spam-site-observe", cron: "12,42 15-22 * * 1-5", migration: "0054" }],
  });
  assert.match(code, /cron\.schedule\('spam-site-observe', '12,42 15-22 \* \* 1-5', \$job\$select public\.spam_cron_call\('\/api\/research\/observe'\)\$job\$\)/);
  assert.match(sql, /Before: 0 calls\. After: 80 calls a week/);
  assert.match(sql, /80 calls\/week × ~1 s CPU/);
  assert.match(sql, /SHIP ORDER: deploy the code FIRST/);
  assert.doesNotMatch(code, /unschedule|drop |delete from/i);
});
