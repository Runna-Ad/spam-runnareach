/**
 * Quiet hours (0053): the autopilot tick and the reply poll keep their pace in
 * the send window and run after it and once a day outside it, to cut Vercel's
 * billed cold starts. Also what the longer gaps touch: the veto digest's
 * promise, the /inbox reply send, the unsubscribe page's copy, and the Sentry
 * setting that made each cold start heavier. The health rules' side is in
 * tests/health-alarms.test.ts and tests/reports-health.test.ts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { digestDue, VETO_WINDOW_HOURS } from "../lib/autopilot/hold.ts";
import { CRON_JOBS, cronsOf } from "../lib/reports/heartbeat.ts";
import { cronMatcher, scheduledRuns } from "../lib/reports/health.ts";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const sql = src("supabase/migrations/0053_quiet_hours_cron.sql");
const code = sql.replace(/--.*$/gm, "");
const t = (iso: string) => new Date(iso).getTime();

test("0053 sets six jobs by job id or creates the missing ones, and drops nothing", () => {
  assert.match(code, /for v_job in select jobid from cron\.job where jobname = v_spec\.jobname loop/);
  assert.match(code, /cron\.alter_job\(job_id := v_job, schedule := v_spec\.schedule\)/);
  assert.match(code, /cron\.schedule\(v_spec\.jobname, v_spec\.schedule, format\('select public\.spam_cron_call\(%L\)', v_spec\.route\)\)/);
  assert.doesNotMatch(code, /unschedule|drop |delete /i);
  const rows = [...code.matchAll(/\('(spam-[a-z-]+)', '([^']+)', '([^']+)'\)/g)].map((m) => ({ pgJob: m[1] ?? "", cron: m[2] ?? "", route: m[3] ?? "" }));
  const expected = (["autopilot-tick", "replies-poll"] as const).flatMap((job) =>
    CRON_JOBS[job].schedules.map((s) => ({ pgJob: s.pgJob, cron: s.cron, route: CRON_JOBS[job].route })),
  );
  assert.deepEqual(
    rows.sort((a, b) => a.pgJob.localeCompare(b.pgJob)),
    expected.sort((a, b) => a.pgJob.localeCompare(b.pgJob)),
  );
});

test("0053 ships after the code: its header says so", () => {
  assert.match(sql, /SHIP ORDER: deploy the code that goes with it FIRST, then apply this\s+-- migration/);
});

test("inside the window nothing changes: tick every 15 min, poll every 10 at :05", () => {
  const window = (from: string, to: string, job: "autopilot-tick" | "replies-poll") => scheduledRuns(cronsOf(job), t(from), t(to), 100);
  assert.equal(window("2026-10-21T14:59:00Z", "2026-10-21T22:59:00Z", "autopilot-tick"), 32);
  assert.equal(window("2026-10-21T14:59:00Z", "2026-10-21T22:59:00Z", "replies-poll"), 48);
});

test("outside the window: one run right after it, then once a day, weekends included", () => {
  const count = (job: "autopilot-tick" | "replies-poll", from: string, to: string) => scheduledRuns(cronsOf(job), t(from), t(to), 1000);
  // A full week (Mon → Sun): the poll 48 in each window, 5 evenings, 7 mornings; the tick 32, 6 evenings
  // (Sunday's included, for Monday's digest), 7 mornings.
  assert.equal(count("autopilot-tick", "2026-10-25T23:59:00Z", "2026-11-01T23:59:00Z"), 5 * 32 + 6 + 7);
  assert.equal(count("replies-poll", "2026-10-25T23:59:00Z", "2026-11-01T23:59:00Z"), 5 * 48 + 5 + 7);
});

test("each quiet tick follows a quiet poll, and the morning runs end before the first send", () => {
  const minuteOf = (cron: string) => {
    const [m, h] = cron.split(" ");
    return Number(h) * 60 + Number(m);
  };
  const poll = Object.fromEntries(CRON_JOBS["replies-poll"].schedules.map((s) => [s.pgJob, s.cron]));
  const tick = Object.fromEntries(CRON_JOBS["autopilot-tick"].schedules.map((s) => [s.pgJob, s.cron]));
  // Morning: poll 13:05, tick 13:15, both before the send-queue's 15:00.
  assert.ok(minuteOf(poll["spam-replies-poll-morning"] as string) < minuteOf(tick["spam-autopilot-tick-morning"] as string));
  assert.ok(minuteOf(tick["spam-autopilot-tick-morning"] as string) < 15 * 60);
  // Evening: the weekday's poll at 23:05; the tick at 01:15 the next UTC day, Sunday evening's included.
  assert.equal(poll["spam-replies-poll-evening"], "5 23 * * 1-5");
  assert.equal(tick["spam-autopilot-tick-evening"], "15 1 * * 1-6");
});

test("every email a tick schedules is in a veto digest at least 6h before it can send (hold.ts)", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const ticks = cronsOf("autopilot-tick").map(cronMatcher);
  const sends = cronsOf("send-queue").map(cronMatcher);
  const start = Date.UTC(2026, 9, 19); // Monday
  const end = start + 21 * 24 * HOUR;
  // Every tick, and the ticks that send a digest: the first one after each slot (digestDue).
  const tickTimes: number[] = [];
  const digestTimes: number[] = [];
  let lastDigestAt: string | null = null;
  for (let m = start; m < end; m += MIN) {
    if (!ticks.some((match) => match(m))) continue;
    tickTimes.push(m);
    if (digestDue(new Date(m), lastDigestAt)) {
      digestTimes.push(m);
      lastDigestAt = new Date(m).toISOString();
    }
  }
  const iso = (ms: number | undefined) => (ms === undefined ? "none" : new Date(ms).toISOString());
  for (const tick of tickTimes.filter((m) => m < end - 5 * 24 * HOUR)) {
    // A tick sends its digest before it schedules (tick.ts), so its own emails wait for the next digest.
    const digest = digestTimes.find((d) => d > tick);
    let send = tick + VETO_WINDOW_HOURS * HOUR;
    while (!sends.some((match) => match(send))) send += MIN;
    assert.ok(digest !== undefined && send - digest >= 6 * HOUR, `scheduled ${iso(tick)}: first digest ${iso(digest)}, sends ${iso(send)}`);
  }
});

test("a reply sent from /inbox asks Gmail for unread messages first, as follow-ups and nudges do", () => {
  const s = src("lib/replies/send-reply-action.ts");
  const from = s.indexOf("export async function approveAndSendReply");
  const fn = s.slice(from, s.indexOf("\nexport async function", from + 1));
  assert.match(fn, /threadBlocksSend\(supabase, tokenResult\.accessToken, \{[^}]*sinceIso: reply\.received_at,\s*mode: "unseen_only",\s*\}\)/);
  assert.ok(fn.indexOf("threadBlocksSend(") < fn.indexOf("sendGmailMessage("), "checked before the send");
  assert.match(fn, /"id, tenant_id, [^"]*, received_at"/);
});

test("the unsubscribe page promises what the reply poll keeps: within 24 hours", () => {
  const s = src("app/api/unsubscribe/route.ts");
  assert.doesNotMatch(s, /right away|de inmediato/);
  assert.match(s, /we'll remove you within 24 hours/);
  assert.match(s, /te quitaremos en menos de 24 horas/);
});

test("Sentry includeLocalVariables stays off: it opens the inspector on every cold start", () => {
  const cfg = src("sentry.server.config.ts").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(cfg, /includeLocalVariables/);
});
