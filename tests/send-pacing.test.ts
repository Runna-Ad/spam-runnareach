/**
 * Send pacing (lib/pitches/send-pacing.ts): one email per inbox and two in
 * total per cron run, in both send routes, and the follow-up job moved to
 * every 10 minutes, 5 after the send-queue (0052).
 *
 * The routes import Next/Gmail and can't load under the node runner, so: the
 * pacer runs through a loop shaped like each route's (check before any read or
 * claim, skip with the reason, stop on a full run, count only real sends), and
 * the call sites are checked from source.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  backOffFollowup,
  createRunPacer,
  FOLLOWUP_RETRY_MS,
  followupRetryAt,
  type BackoffClient,
  INBOX_LIMIT_REASON,
  PER_INBOX_PER_RUN,
  PER_RUN_TOTAL,
  RUN_LIMIT_REASON,
} from "../lib/pitches/send-pacing.ts";
import { CRON_JOBS } from "../lib/reports/heartbeat.ts";

type Due = { id: string; inbox: string | null; fails?: "skip" | "throw" | "after-compose" };
type Outcome = { id: string; status: "sent" | "skipped" | "error"; reason?: string };

/** The routes' loop: pacing first; a claim (and every read) only after it says ok. */
function run(due: Due[]) {
  const pacer = createRunPacer();
  const claimed: string[] = [];
  const results: Outcome[] = [];
  for (const p of due) {
    const pace = pacer.check(p.inbox);
    if (!pace.ok) {
      results.push({ id: p.id, status: "skipped", reason: pace.reason });
      if (pace.stop) break;
      continue;
    }
    try {
      if (p.fails === "skip") {
        results.push({ id: p.id, status: "skipped", reason: "Quality gate" });
        continue;
      }
      if (p.fails === "after-compose") {
        pacer.recordAttempt(p.inbox as string);
        results.push({ id: p.id, status: "skipped", reason: "Gmail send failed" });
        continue;
      }
      claimed.push(p.id);
      if (p.fails === "throw") throw new Error("boom");
      pacer.recordSent(p.inbox as string);
      results.push({ id: p.id, status: "sent" });
    } catch {
      if (p.inbox) pacer.recordSent(p.inbox);
      results.push({ id: p.id, status: "error" });
    }
  }
  return { claimed, results, sent: results.filter((r) => r.status === "sent").map((r) => r.id) };
}

const queue = (inbox: string, n: number, from = 0): Due[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${inbox}-${from + i}`, inbox }));

test("the limits are one per inbox and two per run", () => {
  assert.equal(PER_INBOX_PER_RUN, 1);
  assert.equal(PER_RUN_TOTAL, 2);
});

test("5 due on one inbox: 1 sent, the other 4 skipped with the reason and never claimed", () => {
  const r = run(queue("a", 5));
  assert.deepEqual(r.sent, ["a-0"]);
  assert.deepEqual(r.claimed, ["a-0"]);
  const skipped = r.results.filter((x) => x.status === "skipped");
  assert.equal(skipped.length, 4);
  assert.ok(skipped.every((x) => x.reason === INBOX_LIMIT_REASON));
});

test("2 inboxes with 3 each, interleaved or not: 1 per inbox, oldest first", () => {
  assert.deepEqual(run([...queue("a", 3), ...queue("b", 3)]).sent, ["a-0", "b-0"]);
  const interleaved: Due[] = [];
  for (let i = 0; i < 3; i++) interleaved.push({ id: `a-${i}`, inbox: "a" }, { id: `b-${i}`, inbox: "b" });
  const r = run(interleaved);
  assert.deepEqual(r.sent, ["a-0", "b-0"]);
  // The run is full after two: the next pitch says so and the run stops.
  assert.deepEqual(r.results.at(-1), { id: "a-1", status: "skipped", reason: RUN_LIMIT_REASON });
  assert.deepEqual(r.claimed, ["a-0", "b-0"]);
});

test("3 inboxes: the run stops at 2 in total", () => {
  const r = run([...queue("a", 1), ...queue("b", 1), ...queue("c", 1)]);
  assert.deepEqual(r.sent, ["a-0", "b-0"]);
  assert.deepEqual(r.claimed, ["a-0", "b-0"]);
});

test("a pitch skipped for another reason does not use up its inbox", () => {
  const r = run([{ id: "a-0", inbox: "a", fails: "skip" }, ...queue("a", 2, 1)]);
  assert.deepEqual(r.sent, ["a-1"]);
});

test("a pitch that threw counts against its inbox (Gmail may have taken it)", () => {
  const r = run([{ id: "a-0", inbox: "a", fails: "throw" }, ...queue("a", 2, 1), ...queue("b", 2)]);
  assert.deepEqual(r.sent, ["b-0"]);
  assert.deepEqual(r.claimed, ["a-0", "b-0"]);
});

test("a follow-up that failed after its compose uses up its inbox, not the run total", () => {
  const r = run([{ id: "a-0", inbox: "a", fails: "after-compose" }, ...queue("a", 2, 1), ...queue("b", 1), ...queue("c", 1)]);
  assert.deepEqual(r.sent, ["b-0", "c-0"]);
  assert.ok(r.results.filter((x) => x.id.startsWith("a-") && x.id !== "a-0").every((x) => x.reason === INBOX_LIMIT_REASON));
});

test("no inbox: the pacer lets the route's own skip answer it", () => {
  assert.deepEqual(createRunPacer().check(null), { ok: true });
});

// ── Call sites ───────────────────────────────────────────────────────────────

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const SEND_QUEUE = src("app/api/pitches/send-queue/route.ts");
const FOLLOW_UP = src("app/api/pitches/follow-up/route.ts");

/** The body of the route's `for (const pitch of …)` loop. */
function loopOf(code: string, list: string): string {
  const start = code.indexOf(`for (const pitch of ${list})`);
  assert.ok(start > 0, list);
  return code.slice(start);
}

test("send-queue: pacing is the first thing per pitch, before any read or claim", () => {
  assert.match(SEND_QUEUE, /const SEND_PER_TICK = PER_RUN_TOTAL;/);
  assert.match(SEND_QUEUE, /createRunPacer\(\{ perInbox: 1, total: SEND_PER_TICK \}\)/);
  const loop = loopOf(SEND_QUEUE, "duePitches");
  const check = loop.indexOf("pacer.check(pitch.sender_inbox_id)");
  assert.ok(check > 0);
  for (const later of ['.from("sender_inboxes")', "hasTimeToClaim(startMs)", '.update({ status: "sending" })', "reserveSendSlot(", "sendGmailMessage("]) {
    assert.ok(loop.indexOf(later) > check, later);
  }
  assert.match(loop.slice(check, check + 300), /if \(pace\.stop\) break;\s+continue;/);
  // Counted after the sent row is saved, and on a throw.
  const record = loop.indexOf("pacer.recordSent(inboxId)");
  assert.ok(record > loop.indexOf('status: "sent",'));
  assert.ok(loop.indexOf("pacer.recordSent(pitch.sender_inbox_id)") > loop.indexOf("} catch (err) {"));
  // Jitter only between sends of one run (always different inboxes now).
  assert.match(loop, /if \(pacer\.sent > 0\) \{\s+await new Promise\(\(r\) => setTimeout\(r, Math\.random\(\) \* JITTER_MS\)\);/);
  assert.doesNotMatch(SEND_QUEUE, /sentThisTick|runs daily/);
});

test("follow-up: pacing before processFollowup, counted on a real send or a throw", () => {
  assert.match(FOLLOW_UP, /createRunPacer\(\{ perInbox: PER_INBOX_PER_RUN, total: PER_RUN_TOTAL \}\)/);
  assert.doesNotMatch(FOLLOW_UP, /MAX_PER_RUN/);
  const loop = loopOf(FOLLOW_UP, "pitches");
  const check = loop.indexOf("pacer.check(pitch.sender_inbox_id)");
  // Inside the try, after the loop's pure time-budget check (followup-path-hardening pins that shape).
  assert.ok(check > loop.indexOf("try {") && check > loop.indexOf("hasTimeToCompose(startTime)"));
  assert.ok(check < loop.indexOf("processFollowup("));
  assert.match(loop.slice(check, check + 300), /if \(pace\.stop\) break;\s+continue;/);
  assert.match(loop, /if \(result\.status === "sent" && pitch\.sender_inbox_id\) pacer\.recordSent\(pitch\.sender_inbox_id\);/);
  assert.ok(loop.indexOf("pacer.recordSent(pitch.sender_inbox_id);\n", loop.indexOf("} catch (err) {")) > 0);
});

test("0052 moves spam-follow-up to every 10 minutes at :07, by job id, idempotently", () => {
  const sql = src("supabase/migrations/0052_follow_up_every_10min.sql");
  const code = sql.replace(/--.*$/gm, "");
  assert.match(code, /select jobid from cron\.job where jobname = 'spam-follow-up'/);
  assert.match(code, /cron\.alter_job\(job_id := v_job, schedule := '7-59\/10 15-22 \* \* 1-5'\)/);
  assert.match(code, /cron\.schedule\('spam-follow-up', '7-59\/10 15-22 \* \* 1-5', \$job\$select public\.spam_cron_call\('\/api\/pitches\/follow-up'\)\$job\$\)/);
  assert.doesNotMatch(code, /unschedule|drop /i);
  assert.equal(CRON_JOBS["follow-up"].cron, "7-59/10 15-22 * * 1-5");
  assert.equal(CRON_JOBS["follow-up"].migration, "0052");
  // Same window as the send-queue (:00), 2 minutes after the reply poll (:05).
  assert.equal(CRON_JOBS["send-queue"].cron, "*/10 15-22 * * 1-5");
  assert.equal(CRON_JOBS["replies-poll"].cron, "5-59/10 * * * *");
  // Ship order is written where the conductor applies it.
  assert.match(sql, /SHIP ORDER: apply this migration BEFORE deploying/);
});

// ── Follow-up back-off ───────────────────────────────────────────────────────

/** Records the update and its filters; answers with `rows` matched rows (or an error / a throw). */
function backoffStub(answer: { rows?: number; error?: string; throws?: boolean } = { rows: 1 }) {
  const calls: Array<{ table: string; values: Record<string, unknown>; filters: string[] }> = [];
  const db: BackoffClient = {
    from(table) {
      return {
        update(values) {
          const call = { table, values, filters: [] as string[] };
          calls.push(call);
          const f = {
            eq: (c: string, v: unknown) => (call.filters.push(`eq ${c} ${String(v)}`), f),
            is: (c: string, v: null) => (call.filters.push(`is ${c} ${String(v)}`), f),
            lte: (c: string, v: string) => (call.filters.push(`lte ${c} ${v}`), f),
            select: async () => {
              if (answer.throws) throw new Error("network");
              return answer.error
                ? { data: null, error: { message: answer.error } }
                : { data: Array.from({ length: answer.rows ?? 0 }, () => ({ id: "p1" })), error: null };
            },
          };
          return f;
        },
      };
    },
  };
  return { db, calls };
}

const DUE = "2026-10-22T15:00:00.000Z";
const RETRY = "2026-10-22T16:20:00.000Z";

test("back-off moves a still-due follow-up an hour, only if nobody moved it since", async () => {
  assert.equal(FOLLOWUP_RETRY_MS, 3_600_000);
  assert.equal(followupRetryAt(Date.parse("2026-10-22T15:20:00.000Z")), RETRY);
  const { db, calls } = backoffStub();
  assert.equal(await backOffFollowup(db, { pitchId: "p1", priorStep: 1, priorFollowupAt: DUE, retryAt: RETRY }), true);
  assert.deepEqual(calls, [
    {
      table: "pitches",
      values: { next_followup_at: RETRY },
      filters: ["eq id p1", "eq sequence_step 1", "is sequence_paused_at null", `lte next_followup_at ${DUE}`],
    },
  ]);
});

test("back-off: a row that moved, an error or a throw answers false and never throws", async () => {
  const args = { pitchId: "p1", priorStep: 1, priorFollowupAt: DUE, retryAt: RETRY };
  assert.equal(await backOffFollowup(backoffStub({ rows: 0 }).db, args), false);
  assert.equal(await backOffFollowup(backoffStub({ error: "" }).db, args), false);
  assert.equal(await backOffFollowup(backoffStub({ throws: true }).db, args), false);
});

test("follow-up: every post-compose exit that leaves it due backs off and says so", () => {
  const code = FOLLOW_UP;
  const compose = code.indexOf("composeFollowupWithClaude(");
  const backOffAt = code.indexOf("const backOff = () =>");
  assert.ok(compose > 0 && backOffAt > compose, "defined after the compose");
  // Gate unavailable: moved directly (nothing claimed yet).
  assert.match(code, /if \(!gate\) \{\s+await backOff\(\);\s+return \{[^}]*reason: "Quality gate unavailable — not sent", backed_off: true \};/);
  // After the claim, the release puts the step back due at retryAt.
  assert.match(code, /priorStep: pitch\.sequence_step,\s+priorFollowupAt: retryAt,\s+pause,/);
  assert.match(code, /reason: slot\.reason, backed_off: true \}/);
  assert.match(code, /reason: pause \? `\$\{lastCheck\.reason\} \(sequence paused\)` : lastCheck\.reason,\s+backed_off: true,/);
  assert.match(code, /reason: `Gmail send failed: \$\{sendResult\.error\}`, backed_off: true \}/);
  // A lost claim means the row moved: no back-off there.
  const lost = code.slice(code.indexOf("if (!claimed) {"), code.indexOf("const release = "));
  assert.doesNotMatch(lost, /backOff|backed_off/);
  // The loop counts it against the inbox, not the run total.
  assert.match(code, /else if \(result\.backed_off && pitch\.sender_inbox_id\) pacer\.recordAttempt\(pitch\.sender_inbox_id\);/);
});
