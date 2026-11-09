/**
 * WEB_DIVE_ENABLED (lib/research/web-dive/flag.ts; Pedro 2026-11-09: ship the
 * web search switched off). Drives the real /api/research/web-dive route with
 * every import stubbed by a loader hook except the flag: off, a run answers
 * { ok: true, skipped: "disabled" } inside its heartbeat, with no database
 * client, no claim, no Claude call; on, it runs the dives as before. The
 * first-draft side ("off" counts as done) is in tests/web-dive-ready.test.ts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

const ROUTE = new URL("../app/api/research/web-dive/route.ts", import.meta.url);
const FLAG = new URL("../lib/research/web-dive/flag.ts", import.meta.url).href;
const names = [
  ...new Set(
    [...readFileSync(ROUTE, "utf8").matchAll(/^import \{([^}]*)\} from "([^"]+)";/gm)]
      .filter(([, , from]) => from !== "@/lib/research/web-dive/flag")
      .flatMap(([, list]) => list!.split(",").map((n) => n.trim()))
      .filter((n) => n && !n.startsWith("type ")),
  ),
];

const hooks = `
const PARENT = ${JSON.stringify(ROUTE.href)};
const FLAG = ${JSON.stringify(FLAG)};
const NAMES = ${JSON.stringify(names)};
export async function resolve(spec, ctx, next) {
  if (ctx.parentURL === PARENT) {
    if (spec === "@/lib/research/web-dive/flag") return { url: FLAG, shortCircuit: true };
    return { url: "stub:web-dive-route", shortCircuit: true };
  }
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url !== "stub:web-dive-route") return next(url, ctx);
  const src = NAMES.map((n) =>
    "export const " + n + " = Object.hasOwn(globalThis.__wdValues, " + JSON.stringify(n) + ") ? globalThis.__wdValues[" + JSON.stringify(n) + "]" +
    " : (...a) => globalThis.__wdCall(" + JSON.stringify(n) + ", a);").join("\\n");
  return { format: "module", source: src, shortCircuit: true };
}`;
register("data:text/javascript," + encodeURIComponent(hooks));

type Call = { name: string; args: unknown[] };
const calls: Call[] = [];
const answers: Record<string, (...a: unknown[]) => unknown> = {
  isSchedulerAuthorized: async () => true,
  withHeartbeat: async (_job: unknown, run: unknown) => (run as () => Promise<unknown>)(),
  createServiceRoleClient: () => ({}),
  runWebDives: async () => ({ claimed: 0, dived: 0, saved: 0, released: 0, outcomes: {}, costUsd: 0, stopped: "none_due", stopDetail: null, errors: [] }),
};
const g = globalThis as unknown as { __wdValues: Record<string, unknown>; __wdCall: (n: string, a: unknown[]) => unknown };
g.__wdValues = {
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) },
  ANTHROPIC_DEFAULT_MODEL: "model-default",
  DB_TIMEOUT_MS: 5_000,
};
g.__wdCall = (name, args) => {
  calls.push({ name, args });
  const f = answers[name];
  if (!f) throw new Error(`stub ${name} called`);
  return f(...args);
};

async function run(flag: string | undefined) {
  calls.length = 0;
  const saved = process.env.WEB_DIVE_ENABLED;
  if (flag === undefined) delete process.env.WEB_DIVE_ENABLED;
  else process.env.WEB_DIVE_ENABLED = flag;
  try {
    const { GET } = (await import(ROUTE.href)) as { GET: (req: unknown) => Promise<{ body: Record<string, unknown>; status: number }> };
    return await GET({ headers: new Headers() });
  } finally {
    if (saved === undefined) delete process.env.WEB_DIVE_ENABLED;
    else process.env.WEB_DIVE_ENABLED = saved;
  }
}

test("off (unset, the default): skipped inside the heartbeat; no database client, no claim, no Claude call, no cost", async () => {
  for (const flag of [undefined, "0", "true"]) {
    const res = await run(flag);
    assert.equal(res.status, 200, String(flag));
    assert.deepEqual(res.body, { ok: true, skipped: "disabled" }, String(flag));
    assert.deepEqual(calls.map((c) => c.name), ["isSchedulerAuthorized", "withHeartbeat"], String(flag));
    assert.equal(calls[1]!.args[0], "web-dive");
  }
});

test("on (exactly \"1\"): the run claims and dives as before", async () => {
  const res = await run("1");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.skipped, undefined);
  assert.equal(res.body.stopped, "none_due");
  const names = calls.map((c) => c.name);
  assert.ok(names.includes("createServiceRoleClient"));
  assert.ok(names.includes("runWebDives"));
});

test("0055's header says the flag stays unset at ship, so the cron calls are no-ops", () => {
  const sql = readFileSync(new URL("../supabase/migrations/0055_web_research.sql", import.meta.url), "utf8");
  assert.match(sql, /WEB_DIVE_ENABLED STAYS UNSET/);
  assert.match(sql, /every spam-web-dive call is a no-op/);
});
