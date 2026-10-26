/**
 * Quiet hours (0053): the autopilot tick and the reply poll keep their pace in
 * the send window and run after it and once a day outside it, to cut Vercel's
 * billed cold starts. Also the Sentry setting that made each cold start
 * heavier. The health rules' side is in tests/health-alarms.test.ts and
 * tests/reports-health.test.ts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DIGEST_SLOTS_UTC } from "../lib/autopilot/hold.ts";
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
  // A full week (Mon 00:00 → next Mon 00:00): 32 + 2 a weekday for the tick, 48 + 2 for the poll, 1 a day at weekends.
  assert.equal(count("autopilot-tick", "2026-10-25T23:59:00Z", "2026-11-01T23:59:00Z"), 5 * 32 + 5 + 7);
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
  // Evening: the weekday's poll at 23:05, its tick at 01:15 the next UTC day (Tue-Sat).
  assert.equal(poll["spam-replies-poll-evening"], "5 23 * * 1-5");
  assert.equal(tick["spam-autopilot-tick-evening"], "15 1 * * 2-6");
});

test("a quiet tick runs after each digest slot, so both veto digests still go out on weekdays", () => {
  const quiet = CRON_JOBS["autopilot-tick"].schedules.filter((s) => s.pgJob !== "spam-autopilot-tick").map((s) => cronMatcher(s.cron));
  for (const slot of DIGEST_SLOTS_UTC) {
    // Wednesday 2026-10-21: the first quiet tick within an hour after the slot.
    const start = Date.UTC(2026, 9, 21, slot);
    let found = false;
    for (let m = 0; m <= 60 && !found; m++) found = quiet.some((q) => q(start + m * 60_000));
    assert.ok(found, `no quiet tick within an hour after the ${slot}:00 digest slot`);
  }
});

test("Sentry includeLocalVariables stays off: it opens the inspector on every cold start", () => {
  const cfg = src("sentry.server.config.ts").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(cfg, /includeLocalVariables/);
});
