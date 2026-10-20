/**
 * Follow-up path hardening (phase 3 batch 5):
 *   1. a claim release never pulls next_followup_at back over a date another
 *      writer set after the claim (OOO postpone, snooze)
 *   2. no follow-up composes or claims without time to finish before maxDuration
 *   3. every automatic pause at the last-moment recheck leaves an audit row
 *   4. one "who approved this pitch last" helper, each caller keeps its rule
 *
 * The route imports Next/Gmail and can't load under node:test, so the logic is
 * tested in its lib modules with fakes and the call sites are checked from source.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CLAIM_RESERVE_MS,
  FOLLOWUP_COMPOSE_MS,
  FOLLOWUP_COMPOSE_RESERVE_MS,
  SEND_ROUTE_MAX_MS,
  TIME_BUDGET_REASON,
  hasTimeToClaim,
  hasTimeToCompose,
} from "../lib/pitches/daily-cap.ts";
import {
  FOLLOWUP_PAUSED_ACTION,
  auditFollowupPause,
  followupPausesFor,
  recheckBeforeSend,
  releaseFollowupClaim,
  type AuditInsertClient,
  type FollowupReleaseClient,
  type SendCheckClient,
} from "../lib/pitches/status-transitions.ts";
import { latestApproval, latestApprovals, sendTimeVerdictAction } from "../lib/pitches/send-time-hold.ts";
import { holdAutoApprovals } from "../lib/autopilot/hold.ts";

const T = "tenant-1";
const DAY = 24 * 60 * 60 * 1000;
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const stripComments = (code: string) => code.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

// ── A small PostgREST stand-in ───────────────────────────────────────────────

type Row = Record<string, unknown>;

/** eq/is/or/not/lt/lte/in/order/select/update/insert, with an optional hook before each update runs. */
function memDb(tables: Record<string, Row[]>, opts: { fail?: Record<string, string>; beforeUpdate?: (n: number) => void } = {}) {
  let updates = 0;
  const cmp = (a: unknown, b: unknown) =>
    typeof a === "number" && typeof b === "number" ? a - b : Date.parse(String(a)) - Date.parse(String(b));
  return {
    tables,
    from(table: string) {
      const rows = (tables[table] ??= []);
      const filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "update" | "insert" = "select";
      let patch: Row = {};
      let inserted: Row[] = [];
      let order: { col: string; asc: boolean } | null = null;
      const run = () => {
        const f = opts.fail?.[`${table}.${op}`];
        if (f !== undefined) return { data: null, error: { message: f } };
        if (op === "insert") {
          rows.push(...inserted);
          return { data: null, error: null };
        }
        if (op === "update") opts.beforeUpdate?.(updates++);
        let hit = rows.filter((r) => filters.every((fn) => fn(r)));
        if (op === "update") {
          for (const r of hit) Object.assign(r, patch);
          return { data: hit.map((r) => ({ id: r.id })), error: null };
        }
        if (order) {
          const { col, asc } = order;
          hit = [...hit].sort((a, b) => (asc ? 1 : -1) * (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0));
        }
        return { data: hit.map((r) => ({ ...r })), error: null };
      };
      const b = {
        select: () => b,
        update(v: Row) {
          op = "update";
          patch = v;
          return b;
        },
        insert(v: Row | Row[]) {
          op = "insert";
          inserted = Array.isArray(v) ? v : [v];
          return b;
        },
        eq(k: string, v: unknown) {
          filters.push((r) => (r[k] ?? null) === v);
          return b;
        },
        in(k: string, vs: unknown[]) {
          filters.push((r) => vs.includes(r[k]));
          return b;
        },
        is(k: string, _v: null) {
          filters.push((r) => (r[k] ?? null) === null);
          return b;
        },
        or(f: string) {
          const alts = f.split(",").map((part) => {
            const [col, , ...v] = part.split(".");
            return { col: col!, val: v.join(".") };
          });
          filters.push((r) => alts.some((a) => r[a.col] === a.val));
          return b;
        },
        not(k: string, _op: string, _v: null) {
          filters.push((r) => (r[k] ?? null) !== null);
          return b;
        },
        lte(k: string, v: unknown) {
          filters.push((r) => r[k] !== null && r[k] !== undefined && cmp(r[k], v) <= 0);
          return b;
        },
        lt(k: string, v: unknown) {
          filters.push((r) => r[k] !== null && r[k] !== undefined && cmp(r[k], v) < 0);
          return b;
        },
        order(col: string, o?: { ascending?: boolean }) {
          order = { col, asc: o?.ascending !== false };
          return b;
        },
        limit: () => b,
        maybeSingle: async () => {
          const r = run();
          return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
        },
        then<X>(ok: (v: ReturnType<typeof run>) => X, ko?: (e: unknown) => X) {
          return Promise.resolve(run()).then(ok, ko);
        },
      };
      return b;
    },
  };
}
type MemDb = ReturnType<typeof memDb>;

// ── 1. Release vs. a concurrent OOO postpone / snooze ───────────────────────

const RUN_START = Date.parse("2026-10-20T15:20:00.000Z");
const DUE = "2026-10-20T09:00:00.000Z"; // what the run read: already due

function rootPitch(step = 1): Row {
  return {
    id: "root-1", tenant_id: T, prospect_id: "p1", status: "sent", parent_pitch_id: null,
    sequence_step: step, next_followup_at: DUE, sequence_paused_at: null,
  };
}

/** The route's claim, verbatim in shape (follow-up/route.ts 7c): still due as read, step unmoved, not paused. */
async function tryClaim(db: MemDb, priorStep: number, readFollowupAt: string = DUE): Promise<{ took: boolean; claimedAt: string | null }> {
  const nextStep = priorStep + 1;
  const nextFollowupAt = nextStep === 3 ? null : new Date(RUN_START + 5 * DAY).toISOString();
  const { data } = await db
    .from("pitches")
    .update({ sequence_step: nextStep, next_followup_at: nextFollowupAt })
    .eq("id", "root-1")
    .eq("sequence_step", priorStep)
    .is("sequence_paused_at", null)
    .lte("next_followup_at", readFollowupAt)
    .select()
    .maybeSingle();
  return { took: !!data, claimedAt: nextFollowupAt };
}

/** A claim that must succeed. Returns the date it wrote. */
async function claim(db: MemDb, priorStep: number): Promise<string | null> {
  const r = await tryClaim(db, priorStep);
  assert.ok(r.took, "the claim took the row");
  return r.claimedAt;
}

/** app/api/replies/poll/route.ts postponeSequence, same filters (intent auto_reply, 7 days). */
async function postponeSequence(db: MemDb, days: number): Promise<string> {
  const until = new Date(RUN_START + 30_000 + days * DAY).toISOString();
  await db
    .from("pitches")
    .update({ next_followup_at: until })
    .eq("prospect_id", "p1")
    .eq("tenant_id", T)
    .eq("status", "sent")
    .is("sequence_paused_at", null)
    .not("next_followup_at", "is", null)
    .lt("next_followup_at", until);
  return until;
}

/** lib/replies/intent-actions.ts auto_reply snooze, same filters (14 days, un-pauses). */
async function snooze(db: MemDb): Promise<string> {
  const until = new Date(RUN_START + 30_000 + 14 * DAY).toISOString();
  await db
    .from("pitches")
    .update({ next_followup_at: until, sequence_paused_at: null })
    .eq("prospect_id", "p1")
    .eq("tenant_id", T)
    .eq("status", "sent")
    .is("parent_pitch_id", null)
    .lt("sequence_step", 3);
  return until;
}

const release = (db: MemDb, claimedFollowupAt: string | null, pause: boolean, priorStep = 1) =>
  releaseFollowupClaim(db as unknown as FollowupReleaseClient, {
    pitchId: "root-1",
    claimedStep: priorStep + 1,
    claimedFollowupAt,
    priorStep,
    priorFollowupAt: DUE,
    pause,
    nowIso: "2026-10-20T15:21:00.000Z",
  });

for (const pause of [false, true]) {
  test(`release after an OOO postpone keeps the OOO date, restores the step (pause=${pause})`, async () => {
    const db = memDb({ pitches: [rootPitch()] });
    const claimed = await claim(db, 1);
    const ooo = await postponeSequence(db, 7); // the reply poll, between claim and release
    assert.equal(await release(db, claimed, pause), true);
    const row = db.tables.pitches![0]!;
    assert.equal(row.next_followup_at, ooo, "the OOO week stands");
    assert.equal(row.sequence_step, 1, "the step is given back");
    assert.equal(row.sequence_paused_at, pause ? "2026-10-20T15:21:00.000Z" : null);
  });

  test(`release after a 14-day snooze keeps the snooze date, restores the step (pause=${pause})`, async () => {
    const db = memDb({ pitches: [rootPitch()] });
    const claimed = await claim(db, 1);
    const later = await snooze(db);
    assert.equal(await release(db, claimed, pause), true);
    const row = db.tables.pitches![0]!;
    assert.equal(row.next_followup_at, later);
    assert.equal(row.sequence_step, 1);
    assert.equal(row.sequence_paused_at, pause ? "2026-10-20T15:21:00.000Z" : null);
  });
}

for (const [name, writer] of [
  ["OOO postpone (+7d)", (db: MemDb) => postponeSequence(db, 7)],
  ["14-day snooze", (db: MemDb) => snooze(db)],
] as const) {
  test(`${name} after the due read, before the claim (during pre-work/compose): the claim takes nothing and the date stands`, async () => {
    const db = memDb({ pitches: [rootPitch()] });
    // the run read the row as due (DUE); then the reply poll or a person writes
    const later = await writer(db);
    const r = await tryClaim(db, 1, DUE);
    assert.equal(r.took, false, "no claim → the route returns before the slot, the recheck and Gmail");
    const row = db.tables.pitches![0]!;
    assert.equal(row.next_followup_at, later, "the OOO/snooze date is not overwritten by the claim's +5d");
    assert.equal(row.sequence_step, 1);
  });
}

test("negative set: a row still due as read is claimed (also when its date moved earlier)", async () => {
  const db = memDb({ pitches: [rootPitch()] });
  assert.equal((await tryClaim(db, 1, DUE)).took, true);
  const earlier = memDb({ pitches: [{ ...rootPitch(), next_followup_at: "2026-10-20T08:00:00.000Z" }] });
  assert.equal((await tryClaim(earlier, 1, DUE)).took, true);
});

test("route: the claim is guarded on still-due as the run read it, and a refused claim returns before Gmail", () => {
  const s = stripComments(src("app/api/pitches/follow-up/route.ts"));
  const claimAt = s.indexOf(".update({ sequence_step: nextStep, next_followup_at: nextFollowupAt })");
  const stmt = s.slice(claimAt, s.indexOf(".maybeSingle();", claimAt));
  assert.match(stmt, /\.lte\("next_followup_at", pitch\.next_followup_at\)/);
  assert.match(stmt, /\.eq\("sequence_step", pitch\.sequence_step\)/);
  assert.match(stmt, /\.is\("sequence_paused_at", null\)/);
  const refused = s.indexOf("if (!claimed) {", claimAt);
  assert.ok(refused > claimAt && refused < s.indexOf("await reserveSendSlot(", claimAt), "refused claim handled before the slot");
  const branch = s.slice(refused, s.indexOf("}", refused));
  assert.match(branch, /return \{/);
});

test("the OOO write landing while the release itself runs still wins (no window between check and write)", async () => {
  let ooo = "";
  const db = memDb({ pitches: [rootPitch()] }, {
    beforeUpdate: (n) => {
      // update #0 is the claim; #1 is the release's guarded write: the poll lands right before it.
      if (n === 1) {
        const until = new Date(RUN_START + 30_000 + 7 * DAY).toISOString();
        const r = db.tables.pitches![0]!;
        if (r.next_followup_at !== null && Date.parse(String(r.next_followup_at)) < Date.parse(until)) r.next_followup_at = until;
        ooo = until;
      }
    },
  });
  const claimed = await claim(db, 1);
  await release(db, claimed, false);
  assert.equal(db.tables.pitches![0]!.next_followup_at, ooo);
  assert.equal(db.tables.pitches![0]!.sequence_step, 1);
});

test("negative set: no concurrent writer → the release restores exactly step, date and pause as before", async () => {
  for (const pause of [false, true]) {
    for (const priorStep of [1, 2]) {
      const db = memDb({ pitches: [rootPitch(priorStep)] });
      const claimed = await claim(db, priorStep);
      assert.equal(await release(db, claimed, pause, priorStep), true);
      assert.deepEqual(db.tables.pitches![0], {
        ...rootPitch(priorStep),
        sequence_paused_at: pause ? "2026-10-20T15:21:00.000Z" : null,
      }, `pause=${pause} step=${priorStep}`);
    }
  }
});

test("the final step (claimed date null) releases to the due date; postpone/snooze can't touch it", async () => {
  const db = memDb({ pitches: [rootPitch(2)] });
  const claimed = await claim(db, 2);
  assert.equal(claimed, null);
  await postponeSequence(db, 7); // not null filter: skips the claimed row
  await snooze(db); // sequence_step < 3: skips the claimed row
  await release(db, claimed, false, 2);
  assert.equal(db.tables.pitches![0]!.next_followup_at, DUE);
  assert.equal(db.tables.pitches![0]!.sequence_step, 2);
});

test("a step another run moved on is left alone, date and pause included", async () => {
  const db = memDb({ pitches: [rootPitch()] });
  const claimed = await claim(db, 1);
  db.tables.pitches![0]!.sequence_step = 3;
  assert.equal(await release(db, claimed, true), false);
  assert.equal(db.tables.pitches![0]!.sequence_step, 3);
  assert.equal(db.tables.pitches![0]!.next_followup_at, claimed);
  assert.equal(db.tables.pitches![0]!.sequence_paused_at, null);
});

test("the release never writes a date earlier than the one on the row (property, 200 interleavings)", async () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 200; i++) {
    const db = memDb({ pitches: [rootPitch()] });
    const claimed = await claim(db, 1);
    const writer = rnd();
    if (writer < 0.33) await postponeSequence(db, 1 + Math.floor(rnd() * 14));
    else if (writer < 0.66) await snooze(db);
    const before = String(db.tables.pitches![0]!.next_followup_at);
    await release(db, claimed, rnd() < 0.5);
    const after = String(db.tables.pitches![0]!.next_followup_at);
    if (before !== claimed) assert.ok(Date.parse(after) >= Date.parse(before), `i=${i}: ${before} → ${after}`);
    assert.equal(db.tables.pitches![0]!.sequence_step, 1);
  }
});

test("route: the release carries the date the claim wrote", () => {
  const s = stripComments(src("app/api/pitches/follow-up/route.ts"));
  const claimAt = s.indexOf(".update({ sequence_step: nextStep, next_followup_at: nextFollowupAt })");
  const rel = s.indexOf("releaseFollowupClaim(", claimAt);
  assert.ok(claimAt > 0 && rel > claimAt);
  assert.match(s.slice(rel, rel + 300), /claimedFollowupAt: nextFollowupAt,/);
});

// ── 2. Time budget ──────────────────────────────────────────────────────────

test("budget arithmetic: compose reserve = compose + claim reserve; compose cutoff 70s, claim cutoff 95s", () => {
  assert.equal(SEND_ROUTE_MAX_MS, 120_000);
  assert.equal(FOLLOWUP_COMPOSE_MS, 25_000, "20s Claude timeout (no retries) + cap/cost/gate reads");
  assert.equal(FOLLOWUP_COMPOSE_RESERVE_MS, FOLLOWUP_COMPOSE_MS + CLAIM_RESERVE_MS);
  assert.equal(SEND_ROUTE_MAX_MS - FOLLOWUP_COMPOSE_RESERVE_MS, 70_000);
  assert.equal(SEND_ROUTE_MAX_MS - CLAIM_RESERVE_MS, 95_000);
  assert.equal(hasTimeToCompose(0, 69_999), true);
  assert.equal(hasTimeToCompose(0, 70_000), false);
  assert.equal(hasTimeToClaim(0, 94_999), true);
  assert.equal(hasTimeToClaim(0, 95_000), false);
  // A compose started at the last allowed moment, running its full timeout, can still claim.
  assert.equal(hasTimeToClaim(0, 69_999 + 20_000), true);
});

/**
 * The route's order per pitch with an injected clock: loop-top check → pre-work
 * → compose check → compose → gate → claim check → claim → Gmail. Uses the same
 * helpers and the same break rule as the route (whose shape is pinned below).
 */
function simulateRun(startAt: number, pitches: number, costs: { pre: number; compose: number; post: number }) {
  let now = startAt;
  const log = { claude: 0, claims: 0, sent: 0, results: [] as string[] };
  const one = (): string => {
    now += costs.pre;
    if (!hasTimeToCompose(0, now)) return TIME_BUDGET_REASON;
    log.claude++;
    now += costs.compose;
    if (!hasTimeToClaim(0, now)) return TIME_BUDGET_REASON;
    log.claims++;
    now += costs.post;
    log.sent++;
    return "sent";
  };
  for (let i = 0; i < pitches; i++) {
    if (!hasTimeToCompose(0, now)) {
      log.results.push(TIME_BUDGET_REASON);
      break;
    }
    const r = one();
    log.results.push(r);
    if (r === TIME_BUDGET_REASON) break;
  }
  return { ...log, endedAt: now };
}

test("budget: a follow-up reached at 69s whose pre-work ends past 70s is not composed (0 Claude calls), and the loop stops", () => {
  const r = simulateRun(69_000, 5, { pre: 2_000, compose: 20_000, post: 5_000 });
  assert.equal(r.claude, 0);
  assert.equal(r.claims, 0);
  assert.deepEqual(r.results, [TIME_BUDGET_REASON], "one result, then break");
});

test("budget: a compose that runs long enough is not claimed, and the loop stops", () => {
  // composed at 66s, compose + gate take 30s → 96s, past the 95s claim cutoff
  const r = simulateRun(65_000, 5, { pre: 1_000, compose: 30_000, post: 5_000 });
  assert.equal(r.claude, 1);
  assert.equal(r.claims, 0);
  assert.deepEqual(r.results, [TIME_BUDGET_REASON]);
});

test("budget: worst case per follow-up, every run ends before maxDuration", () => {
  for (const start of [0, 30_000, 60_000, 69_999]) {
    // token 10s + thread read ~5s pre-work, 20s compose + 5s gate, 25s after the claim
    const r = simulateRun(start, 30, { pre: 15_000, compose: 25_000, post: 25_000 });
    assert.ok(r.endedAt <= SEND_ROUTE_MAX_MS, `start ${start}: ended at ${r.endedAt}`);
  }
});

test("route: compose and claim are budget-checked with the shared helpers, and the loop breaks", () => {
  const s = stripComments(src("app/api/pitches/follow-up/route.ts"));
  assert.ok(!/TIME_BUDGET_MS/.test(s), "no private budget constant");
  assert.ok(!s.includes('"Time budget reached'), "the shared reason constant, not a literal");

  // compose: the check sits before the Claude branch and returns the budget reason
  const composeCheck = s.indexOf("if (!hasTimeToCompose(startTime)) {");
  const claude = s.indexOf("if (claudeIsAvailable()) {");
  const compose = s.indexOf("composeFollowupWithClaude(");
  assert.ok(composeCheck > 0 && composeCheck < claude && claude < compose, `${composeCheck} < ${claude} < ${compose}`);
  const between = s.slice(composeCheck, claude);
  assert.match(between, /return \{[^}]*reason: TIME_BUDGET_REASON \};/);
  assert.ok(!/\bawait\b/.test(between.slice(between.indexOf("};"))), "nothing waits between the check and the compose branch");

  // claim: re-checked right before the claim UPDATE, nothing awaited in between
  const claimAt = s.indexOf(".update({ sequence_step: nextStep");
  const claimCheck = s.lastIndexOf("if (!hasTimeToClaim(startTime)) {", claimAt);
  assert.ok(claimCheck > compose, "after the compose");
  const toClaim = s.slice(claimCheck, claimAt);
  assert.match(toClaim, /return \{[^}]*reason: TIME_BUDGET_REASON \};/);
  assert.equal((toClaim.match(/\bawait\b/g) ?? []).length, 1, "only the claim's own await");

  // loop: top check uses the compose budget and breaks; a budget result breaks too
  const loop = s.slice(s.indexOf("for (const pitch of pitches) {"));
  const top = loop.slice(0, loop.indexOf("try {"));
  assert.match(top, /if \(!hasTimeToCompose\(startTime\)\) \{[\s\S]*?break;\s*\}/);
  assert.ok(!/continue;/.test(top), "out of time stops the loop");
  assert.match(loop, /processFollowup\(pitch, bounceBlocks, startTime\);\s*results\.push\(result\);\s*if \(result\.reason === TIME_BUDGET_REASON\) break;/);
});

// ── 3. Audit every automatic pause at the last-moment recheck ───────────────

const EMAIL = "owner@acme.ca";

function tailWorld(status: string, opts: { dnc?: boolean } = {}) {
  return memDb({
    prospects: [{ id: "p1", tenant_id: T, status, cooldown_until: null }],
    do_not_contact_list: opts.dnc ? [{ id: "d1", tenant_id: T, email: EMAIL, domain: null, entry_type: "manual" }] : [],
    pitches: [{ ...rootPitch(), sequence_step: 2, next_followup_at: "2026-10-25T15:20:00.000Z" }],
    audit_log: [],
  });
}

/** The route's 7d branch: recheck → release(pause) → audit when paused and released. */
async function recheckTail(db: MemDb) {
  const lastCheck = await recheckBeforeSend(db as unknown as SendCheckClient, {
    tenantId: T, prospectId: "p1", email: EMAIL, nowIso: "2026-10-20T15:21:00.000Z",
  });
  if (!lastCheck) return null;
  const pause = followupPausesFor(lastCheck);
  const released = await releaseFollowupClaim(db as unknown as FollowupReleaseClient, {
    pitchId: "root-1", claimedStep: 2, claimedFollowupAt: "2026-10-25T15:20:00.000Z",
    priorStep: 1, priorFollowupAt: DUE, pause,
  });
  if (pause && released) {
    await auditFollowupPause(db as unknown as AuditInsertClient, { tenantId: T, pitchId: "root-1", step: 2, block: lastCheck });
  }
  return lastCheck;
}

test("recheck pause: one audit row per pause, with the block kind", async () => {
  for (const [status, dnc, kind] of [["suppressed", false, "do_not_send"], ["pitched", true, "dnc"]] as const) {
    const db = tailWorld(status, { dnc });
    const block = await recheckTail(db);
    assert.equal(block?.kind, kind);
    assert.ok(db.tables.pitches![0]!.sequence_paused_at, "paused");
    assert.deepEqual(db.tables.audit_log, [{
      tenant_id: T,
      actor_id: null,
      action: "pitch.sequence_paused",
      entity_type: "pitch",
      entity_id: "root-1",
      metadata: { source: "follow-up recheck", kind, reason: block!.reason, step: 2 },
    }], kind);
  }
});

test("recheck release without a pause (unreadable) writes no audit row", async () => {
  const db = tailWorld("pitched");
  db.tables.prospects = [];
  const block = await recheckTail(db);
  assert.equal(block?.kind, "unreadable");
  assert.equal(db.tables.pitches![0]!.sequence_paused_at, null);
  assert.deepEqual(db.tables.audit_log, []);
});

test("auditFollowupPause never throws on a failed write", async () => {
  const db = memDb({ audit_log: [] }, { fail: { "audit_log.insert": "" } });
  const warn = console.warn;
  const seen: unknown[] = [];
  console.warn = (...a: unknown[]) => { seen.push(a); };
  try {
    await auditFollowupPause(db as unknown as AuditInsertClient, { tenantId: T, pitchId: "x", step: 2, block: { kind: "dnc", reason: "r" } });
  } finally {
    console.warn = warn;
  }
  assert.equal(seen.length, 1);
});

test("route: the recheck branch audits when it paused and released; the action is in the AuditAction union", () => {
  const s = stripComments(src("app/api/pitches/follow-up/route.ts"));
  const ifAt = s.indexOf("if (lastCheck) {");
  const branch = s.slice(ifAt, s.indexOf("await sendGmailMessage(", ifAt));
  assert.match(branch, /const released = await release\(pause\);\s*if \(pause && released\) \{\s*await auditFollowupPause\(/);
  assert.match(branch, /block: lastCheck,/);
  assert.equal(FOLLOWUP_PAUSED_ACTION, "pitch.sequence_paused");
  assert.match(src("lib/audit/log.ts"), /\| "pitch\.sequence_paused"/);
});

// ── 4. One "who approved this pitch last" helper ────────────────────────────

const approvalEvent = (pitch: string, at: string, autopilot: boolean) => ({
  id: `ev-${pitch}-${at}`, tenant_id: T, pitch_id: pitch, event_type: "approved", event_at: at, payload: { by: "u1", autopilot },
});

const HISTORIES = {
  none: [] as boolean[],
  person: [false],
  autopilot: [true],
  person_then_autopilot: [false, true],
  autopilot_then_person: [true, false],
} as const;

function approvalWorld() {
  const pitches: Row[] = [];
  const pitch_events: Row[] = [];
  for (const [id, hist] of Object.entries(HISTORIES)) {
    pitches.push({ id, tenant_id: T, status: "approved", autopilot_lane: "auto", sent_at: null, autopilot_reasons: null });
    hist.forEach((a, i) => pitch_events.push(approvalEvent(id, `2026-10-1${8 + i}T10:00:00Z`, a)));
  }
  return memDb({ pitches, pitch_events, audit_log: [] });
}

test("table: send-time hold decides exactly as before for every history, read error included", async () => {
  const expected: Record<string, [string, string]> = {
    none: ["none", "hold"],
    person: ["person", "send"],
    autopilot: ["autopilot", "hold"],
    person_then_autopilot: ["autopilot", "hold"],
    autopilot_then_person: ["person", "send"],
  };
  const db = approvalWorld();
  for (const [id, [source, action]] of Object.entries(expected)) {
    const got = await latestApproval(db, T, id);
    assert.equal(got, source, id);
    assert.equal(sendTimeVerdictAction("review", got), action, id);
  }
  const broken = memDb({ pitch_events: [] }, { fail: { "pitch_events.select": "" } });
  assert.equal(await latestApproval(broken, T, "autopilot"), "unreadable");
  assert.equal(sendTimeVerdictAction("review", "unreadable"), "skip");
});

test("table: holdAutoApprovals holds exactly the latest-autopilot pitches; a read error aborts the sweep", async () => {
  const db = approvalWorld();
  const r = await holdAutoApprovals(db, T, "shadow");
  assert.deepEqual(r, { held: 2, error: null });
  const heldIds = db.tables.pitches!.filter((p) => p.status === "draft").map((p) => p.id).sort();
  assert.deepEqual(heldIds, ["autopilot", "person_then_autopilot"]);

  const broken = approvalWorld();
  const failing = memDb(broken.tables, { fail: { "pitch_events.select": "" } });
  const e = await holdAutoApprovals(failing, T, "shadow");
  assert.deepEqual(e, { held: 0, error: "approval events: no detail" });
  assert.ok(broken.tables.pitches!.every((p) => p.status === "approved"), "nothing held on an unreadable log");
});

test("latestApprovals reports only: absent for no event, an error for a failed read", async () => {
  const r = await latestApprovals(approvalWorld(), T, Object.keys(HISTORIES));
  assert.ok(r.ok);
  assert.deepEqual([...r.byPitch.entries()].sort(), [
    ["autopilot", "autopilot"], ["autopilot_then_person", "person"], ["person", "person"], ["person_then_autopilot", "autopilot"],
  ]);
  assert.deepEqual(await latestApprovals(memDb({}, { fail: { "pitch_events.select": "boom" } }), T, ["x"]), { ok: false, error: "boom" });
  assert.deepEqual(await latestApprovals(memDb({}), T, []), { ok: true, byPitch: new Map() });
});

test("one helper: neither caller keeps its own approval reader", () => {
  for (const f of ["lib/autopilot/hold.ts", "lib/pitches/send-time-hold.ts"]) {
    const s = stripComments(src(f));
    const defs = (s.match(/function isAutopilotApproval\(/g) ?? []).length;
    assert.equal(defs, f.endsWith("send-time-hold.ts") ? 1 : 0, f);
  }
  const hold = stripComments(src("lib/autopilot/hold.ts"));
  assert.match(hold, /await latestApprovals\(db, tenantId, part\)/);
  assert.ok(!/from\("pitch_events"\)[\s\S]{0,80}event_type", "approved"/.test(hold), "no inline approval query left in hold.ts");
});

// ── 5. Dead code ────────────────────────────────────────────────────────────

test("the read-then-write sends_today bump is gone from daily-cap", () => {
  const s = src("lib/pitches/daily-cap.ts");
  assert.ok(!/export function bump/.test(s));
  assert.ok(!/nudge still uses/.test(s));
});
