/**
 * Send-path safety: the four send paths ask one question ("may this prospect be
 * emailed") with one set, ask it again after the claim right before the Gmail
 * call, fail closed when they can't read the answer, and never re-approve a
 * pitch that left 'sending' meanwhile.
 *
 * The routes and the "use server" action import Next/Gmail and can't load under
 * the node runner, so: the shared helpers run against an in-memory Supabase
 * stand-in, and the call sites are checked from source (order of claim →
 * recheck → Gmail, no private status set, no unguarded rollback).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canNeverSend,
  followupPausesFor,
  prospectSendBlock,
  queueReleaseFor,
  recheckBeforeSend,
  releaseClaim,
  releaseFollowupClaim,
  type FollowupReleaseClient,
  type ReleaseClient,
  type SendCheckClient,
} from "../lib/pitches/status-transitions.ts";
import { isEmailOnDncList, type DncClient } from "../lib/discover/dnc-check.ts";

// ── In-memory Supabase stand-in ─────────────────────────────────────────────

type Row = Record<string, unknown>;
type Db = Record<string, Row[]>;

/** Enough of the PostgREST builder for these helpers: select/update + eq/in/or/limit/maybeSingle. */
function memoryClient(db: Db, failReads: Record<string, string> = {}) {
  const updates: Array<{ table: string; payload: Row; matched: number }> = [];
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "update" = "select";
    let payload: Row = {};
    let lim = Infinity;
    const run = () => {
      // `in`, not truthiness: postgrest-js reports an empty-body 502/503/504 as { message: "" }.
      if (mode === "select" && table in failReads) return { data: null, error: { message: failReads[table] } };
      const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (mode === "update") {
        for (const r of rows) Object.assign(r, payload);
        updates.push({ table, payload, matched: rows.length });
        return { data: rows.map((r) => ({ id: r.id })), error: null };
      }
      return { data: rows.slice(0, lim).map((r) => ({ ...r })), error: null };
    };
    const q = {
      select: () => q,
      update: (p: Row) => {
        mode = "update";
        payload = p;
        return q;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return q;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return q;
      },
      or: (f: string) => {
        const alts = f.split(",").map((part) => {
          const [col, , ...v] = part.split(".");
          return { col: col!, val: v.join(".") };
        });
        filters.push((r) => alts.some((a) => r[a.col] === a.val));
        return q;
      },
      limit: (n: number) => {
        lim = n;
        return q;
      },
      maybeSingle: () => {
        const r = run();
        const data = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data;
        return Promise.resolve({ data, error: r.error });
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return q;
  }
  return { client: { from }, updates };
}

const T = "tenant-1";
const NOW = "2026-10-19T15:00:00.000Z";
const EMAIL = "owner@acme.ca";

function world(prospectStatus: string | null, opts: { dnc?: boolean; cooldown?: string; noProspect?: boolean } = {}): Db {
  return {
    prospects: opts.noProspect
      ? []
      : [{ id: "p1", tenant_id: T, status: prospectStatus, cooldown_until: opts.cooldown ?? null }],
    do_not_contact_list: opts.dnc
      ? [{ id: "d1", tenant_id: T, email: EMAIL, domain: null, entry_type: "manual" }]
      : [],
    pitches: [{ id: "pitch-1", tenant_id: T, status: "sending" }],
  };
}

const check = (db: Db, fail: Record<string, string> = {}) =>
  recheckBeforeSend(memoryClient(db, fail).client as unknown as SendCheckClient, {
    tenantId: T,
    prospectId: "p1",
    email: EMAIL,
    nowIso: NOW,
  });

// ── The question itself ─────────────────────────────────────────────────────

test("recheck: a sendable prospect, not on the DNC list → may send", async () => {
  assert.equal(await check(world("pitched")), null);
});

test("recheck: prospect became suppressed after the claim → do_not_send", async () => {
  const block = await check(world("suppressed"));
  assert.deepEqual(block, { kind: "do_not_send", reason: "Prospect is suppressed" });
});

test("recheck: every do-not-send status blocks", async () => {
  for (const s of ["suppressed", "archived_no_meeting", "no_match", "lost", "won", "booked"]) {
    assert.equal((await check(world(s)))?.kind, "do_not_send", s);
  }
});

test("recheck: recipient became DNC-listed after the claim → dnc", async () => {
  const block = await check(world("pitched", { dnc: true }));
  assert.equal(block?.kind, "dnc");
});

test("recheck: cooldown still in force → cooldown (not a drop)", async () => {
  const block = await check(world("pitched", { cooldown: "2026-10-20T00:00:00.000Z" }));
  assert.equal(block?.kind, "cooldown");
  assert.deepEqual(queueReleaseFor(block!), { to: "approved" });
  assert.equal(await check(world("pitched", { cooldown: "2026-10-18T00:00:00.000Z" })), null);
});

test("recheck: prospect read error → unreadable, never send", async () => {
  const block = await check(world("pitched"), { prospects: "connection reset" });
  assert.equal(block?.kind, "unreadable");
  assert.match(block!.reason, /connection reset/);
});

test("recheck: missing prospect row → unreadable, never send", async () => {
  assert.equal((await check(world(null, { noProspect: true })))?.kind, "unreadable");
  assert.equal((await check(world(null)))?.kind, "unreadable");
});

test("first read (prospectSendBlock): error or missing row blocks; neither drops from the queue", () => {
  for (const block of [
    prospectSendBlock(null, { message: "timeout" }, NOW),
    prospectSendBlock(null, null, NOW),
    prospectSendBlock(undefined, null, NOW),
    prospectSendBlock({ status: "pitched", cooldown_until: null }, { message: "x" }, NOW),
  ]) {
    assert.equal(block?.kind, "unreadable");
    assert.deepEqual(queueReleaseFor(block!), { to: "approved" }, "an unreadable prospect is never auto_rejected");
  }
  assert.equal(prospectSendBlock({ status: "approved", cooldown_until: null }, null, NOW), null);
});

test("queue release: can-never-send → auto_rejected with the reason; else back to approved", () => {
  assert.deepEqual(queueReleaseFor({ kind: "do_not_send", reason: "Prospect is suppressed" }), {
    to: "auto_rejected",
    reason: "Prospect is suppressed",
  });
  assert.deepEqual(queueReleaseFor({ kind: "dnc", reason: "on DNC" }), { to: "auto_rejected", reason: "on DNC" });
  assert.deepEqual(queueReleaseFor({ kind: "unreadable", reason: "x" }), { to: "approved" });
});

// ── Releasing a claim ───────────────────────────────────────────────────────

test("releaseClaim: a still-claimed pitch goes back to approved", async () => {
  const db = world("pitched");
  const { client } = memoryClient(db);
  await releaseClaim(client as unknown as ReleaseClient, { pitchId: "pitch-1", to: "approved" });
  assert.equal(db.pitches![0]!.status, "approved");
});

test("releaseClaim: last-moment do-not-send → auto_rejected with the reason (queue)", async () => {
  const db = world("suppressed");
  const { client } = memoryClient(db);
  await releaseClaim(client as unknown as ReleaseClient, {
    pitchId: "pitch-1",
    ...queueReleaseFor({ kind: "do_not_send", reason: "Prospect is suppressed" }),
  });
  assert.equal(db.pitches![0]!.status, "auto_rejected");
  assert.equal(db.pitches![0]!.auto_rejected, true);
  assert.equal(db.pitches![0]!.auto_rejected_reason, "Prospect is suppressed");
});

test("releaseClaim (failed-send rollback): a pitch rejected while 'sending' is NOT re-approved", async () => {
  for (const meanwhile of ["reviewer_rejected", "draft", "sent", "auto_rejected"]) {
    const db = world("pitched");
    db.pitches![0]!.status = meanwhile;
    const { client, updates } = memoryClient(db);
    await releaseClaim(client as unknown as ReleaseClient, { pitchId: "pitch-1", tenantId: T, to: "approved" });
    assert.equal(db.pitches![0]!.status, meanwhile, meanwhile);
    assert.equal(updates[0]?.matched, 0);
  }
});

test("releaseClaim: the tenant filter applies when given (manual send)", async () => {
  const db = world("pitched");
  const { client } = memoryClient(db);
  await releaseClaim(client as unknown as ReleaseClient, { pitchId: "pitch-1", tenantId: "other", to: "approved" });
  assert.equal(db.pitches![0]!.status, "sending");
});

// ── Follow-up: last moment after the step claim ─────────────────────────────

/** A follow-up whose step 1 → 2 this run already claimed (sequence_step = 2). */
function followupWorld(prospectStatus: string, opts: { dnc?: boolean } = {}): Db {
  const db = world(prospectStatus, opts);
  db.pitches = [{ id: "pitch-1", tenant_id: T, status: "sent", sequence_step: 2, next_followup_at: null, sequence_paused_at: null }];
  return db;
}

/** The route's tail after the claim: recheck, and on a block release (pausing if it can never send). */
async function followupTail(db: Db, fail: Record<string, string> = {}) {
  const { client } = memoryClient(db, fail);
  let gmailCalls = 0;
  const lastCheck = await recheckBeforeSend(client as unknown as SendCheckClient, {
    tenantId: T,
    prospectId: "p1",
    email: EMAIL,
    nowIso: NOW,
  });
  if (lastCheck) {
    await releaseFollowupClaim(client as unknown as FollowupReleaseClient, {
      pitchId: "pitch-1",
      claimedStep: 2,
      priorStep: 1,
      priorFollowupAt: "2026-10-22T15:00:00.000Z",
      pause: followupPausesFor(lastCheck),
      nowIso: NOW,
    });
    return { lastCheck, gmailCalls };
  }
  gmailCalls++;
  return { lastCheck, gmailCalls };
}

test("follow-up: prospect suppressed during compose → no Gmail, step released, sequence paused", async () => {
  const db = followupWorld("suppressed");
  const r = await followupTail(db);
  assert.equal(r.gmailCalls, 0);
  assert.equal(r.lastCheck?.kind, "do_not_send");
  const row = db.pitches![0]!;
  assert.equal(row.sequence_step, 1);
  assert.equal(row.next_followup_at, "2026-10-22T15:00:00.000Z");
  assert.equal(row.sequence_paused_at, NOW);
});

test("follow-up: recipient DNC-listed during compose → no Gmail, step released, sequence paused", async () => {
  const db = followupWorld("sent", { dnc: true });
  const r = await followupTail(db);
  assert.equal(r.gmailCalls, 0);
  assert.equal(r.lastCheck?.kind, "dnc");
  assert.equal(db.pitches![0]!.sequence_step, 1);
  assert.equal(db.pitches![0]!.sequence_paused_at, NOW);
});

test("follow-up: unreadable prospect or DNC list → released for a later run, NOT paused", async () => {
  for (const fail of [{ prospects: "timeout" }, { do_not_contact_list: "timeout" }] as Record<string, string>[]) {
    const db = followupWorld("sent");
    const r = await followupTail(db, fail);
    assert.equal(r.gmailCalls, 0);
    assert.equal(r.lastCheck?.kind, "unreadable");
    assert.equal(db.pitches![0]!.sequence_step, 1);
    assert.equal(db.pitches![0]!.sequence_paused_at, null);
  }
});

test("follow-up: a sendable prospect still sends (negative set)", async () => {
  const db = followupWorld("sent");
  const r = await followupTail(db);
  assert.equal(r.gmailCalls, 1);
  assert.equal(db.pitches![0]!.sequence_step, 2);
});

test("releaseFollowupClaim is guarded on the claimed step", async () => {
  const db = followupWorld("sent");
  db.pitches![0]!.sequence_step = 3; // another run moved it on
  const { client, updates } = memoryClient(db);
  await releaseFollowupClaim(client as unknown as FollowupReleaseClient, {
    pitchId: "pitch-1", claimedStep: 2, priorStep: 1, priorFollowupAt: null, pause: true, nowIso: NOW,
  });
  assert.equal(db.pitches![0]!.sequence_step, 3);
  assert.equal(db.pitches![0]!.sequence_paused_at, null);
  assert.equal(updates[0]?.matched, 0);
});

test("followupPausesFor: only can-never-send pauses", () => {
  assert.equal(followupPausesFor({ kind: "do_not_send", reason: "" }), true);
  assert.equal(followupPausesFor({ kind: "dnc", reason: "" }), true);
  assert.equal(followupPausesFor({ kind: "cooldown", reason: "" }), false);
  assert.equal(followupPausesFor({ kind: "unreadable", reason: "" }), false);
});

// ── DNC query error: unreadable at the last moment only ─────────────────────

test("recheck: DNC query error → unreadable, never send", async () => {
  const block = await check(world("pitched"), { do_not_contact_list: "statement timeout" });
  assert.equal(block?.kind, "unreadable");
  assert.match(block!.reason, /do-not-contact list: statement timeout/);
});

test("recheck: DNC lookup that throws → unreadable, never send", async () => {
  const { client } = memoryClient(world("pitched"));
  const throwing = {
    from: (t: string) => (t === "do_not_contact_list" ? (() => { throw new Error("socket hang up"); })() : client.from(t)),
  };
  const block = await recheckBeforeSend(throwing as unknown as SendCheckClient, {
    tenantId: T, prospectId: "p1", email: EMAIL, nowIso: NOW,
  });
  assert.equal(block?.kind, "unreadable");
  assert.match(block!.reason, /socket hang up/);
});

test("recheck: DNC error with an EMPTY message (empty-body 5xx) → unreadable, never send", async () => {
  const block = await check(world("pitched"), { do_not_contact_list: "" });
  assert.equal(block?.kind, "unreadable");
  assert.ok(block!.reason.length > "Couldn't read the do-not-contact list: ".length, block!.reason);
});

test("recheck: DNC lookup throwing new Error() (no message) → unreadable, never send", async () => {
  const { client } = memoryClient(world("pitched"));
  const throwing = {
    from: (t: string) => (t === "do_not_contact_list" ? (() => { throw new Error(); })() : client.from(t)),
  };
  const block = await recheckBeforeSend(throwing as unknown as SendCheckClient, {
    tenantId: T, prospectId: "p1", email: EMAIL, nowIso: NOW,
  });
  assert.equal(block?.kind, "unreadable");
});

test("isEmailOnDncList never reports an empty error string", async () => {
  const empty = await isEmailOnDncList(
    memoryClient(world("pitched"), { do_not_contact_list: "" }).client as unknown as DncClient, T, EMAIL,
  );
  assert.equal(empty.blocked, false);
  assert.ok(!empty.blocked && typeof empty.error === "string" && empty.error.length > 0, JSON.stringify(empty));
  const thrown = await isEmailOnDncList(
    { from: () => { throw new Error(); } } as unknown as DncClient, T, EMAIL,
  );
  assert.ok(!thrown.blocked && typeof thrown.error === "string" && thrown.error.length > 0, JSON.stringify(thrown));
  const nullErr = await isEmailOnDncList(
    { from: () => ({ select: () => ({ eq: () => ({ or: () => ({ limit: () => Promise.resolve({ data: null, error: {} }) }) }) }) }) } as unknown as DncClient,
    T, EMAIL,
  );
  assert.ok(!nullErr.blocked && typeof nullErr.error === "string" && nullErr.error.length > 0, JSON.stringify(nullErr));
});

test("follow-up route: the blocked branch pauses per followupPausesFor (not a constant)", () => {
  const s = src(SEND_PATHS.followUp);
  const ifAt = s.indexOf("if (lastCheck) {");
  assert.ok(ifAt > 0);
  const branch = s.slice(ifAt, blockEnd(s, ifAt + "if (lastCheck) ".length));
  assert.match(branch, /const pause = followupPausesFor\(lastCheck\);/);
  assert.match(branch, /await release\(pause\);/);
});

test("isEmailOnDncList: a query error still fails open for first-read callers, with the error visible", async () => {
  const { client } = memoryClient(world("pitched", { dnc: true }), { do_not_contact_list: "statement timeout" });
  const hit = await isEmailOnDncList(client as unknown as DncClient, T, EMAIL);
  assert.equal(hit.blocked, false); // what send-queue / send-action / follow-up / nudge / reply first-reads see
  assert.equal(!hit.blocked && hit.error, "statement timeout");
  const ok = await isEmailOnDncList(memoryClient(world("pitched")).client as unknown as DncClient, T, EMAIL);
  assert.deepEqual(ok, { blocked: false });
});

test("first-read DNC checks branch on .blocked only (unchanged fail-open)", () => {
  for (const path of [SEND_PATHS_FIRST_READ.sendQueue, SEND_PATHS_FIRST_READ.sendAction, SEND_PATHS_FIRST_READ.followUp]) {
    const s = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.ok(/const dnc = await isEmailOnDncList\(/.test(s), path);
    assert.ok(!/dnc\.error/.test(s), `${path} must keep failing open on a DNC read error`);
  }
});

const SEND_PATHS_FIRST_READ = {
  sendQueue: "app/api/pitches/send-queue/route.ts",
  sendAction: "lib/pitches/send-action.ts",
  followUp: "app/api/pitches/follow-up/route.ts",
} as const;

// ── The call sites, from source ─────────────────────────────────────────────

const SEND_PATHS = {
  sendQueue: "app/api/pitches/send-queue/route.ts",
  sendAction: "lib/pitches/send-action.ts",
  followUp: "app/api/pitches/follow-up/route.ts",
  nudge: "app/api/replies/nudge/route.ts",
} as const;
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("no send path defines its own do-not-send set", () => {
  for (const [name, path] of Object.entries(SEND_PATHS)) {
    const s = src(path);
    // Any of the set's values as a string literal means a private copy.
    for (const v of ["suppressed", "archived_no_meeting", "no_match", "booked"]) {
      assert.ok(!s.includes(`"${v}"`), `${name} has its own "${v}" literal`);
    }
    assert.ok(!/const\s+(MANUAL_DO_NOT_SEND|DO_NOT_SEND_STATUSES|INACTIVE_STATUSES)\s*=/.test(s), `${name} defines a status set`);
    assert.ok(
      s.includes("DO_NOT_SEND_STATUSES") || s.includes("prospectSendBlock"),
      `${name} must ask the shared set (DO_NOT_SEND_STATUSES or prospectSendBlock)`,
    );
  }
});

/** Position of the first match, failing loudly when absent. */
function at(s: string, needle: string | RegExp, from = 0, label = String(needle)): number {
  const i = typeof needle === "string" ? s.indexOf(needle, from) : s.slice(from).search(needle) + from;
  assert.ok(i >= from && (typeof needle !== "string" || i !== -1), `missing ${label}`);
  return i;
}

/** Index just past the `}` closing the `{` at `open`. Source here has no braces inside strings that matter. */
function blockEnd(s: string, open: number): number {
  assert.equal(s[open], "{");
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i + 1;
  }
  assert.fail("unbalanced braces");
}

const stripComments = (code: string) => code.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * claim → `await recheckBeforeSend(…)` → `if (lastCheck) { release; return|continue }`
 * → `await sendGmailMessage(` with NO other await in between: nothing that waits
 * (token, jitter, DNS verify, a query) may sit between the last question and the send.
 */
function assertLastMomentShape(s: string, claimNeedle: string, releaseNeedle: string): void {
  const claim = at(s, claimNeedle);
  const recheck = at(s, "await recheckBeforeSend(", claim, "await recheckBeforeSend after the claim");
  const stmtEnd = at(s, "});", recheck, "end of the recheck call") + 3;
  const ifAt = at(s, "if (lastCheck) {", stmtEnd, "if (lastCheck) after the recheck");
  assert.equal(stripComments(s.slice(stmtEnd, ifAt)).trim(), "", "the blocked branch must follow the recheck directly");
  const open = ifAt + "if (lastCheck) ".length;
  const close = blockEnd(s, open);
  const branch = s.slice(open, close);
  assert.ok(branch.includes(releaseNeedle), `a blocked recheck must release the claim (${releaseNeedle})`);
  assert.ok(/\b(return|continue)\b/.test(branch), "a blocked recheck must not fall through to Gmail");
  const gmail = at(s, "await sendGmailMessage(", close, "await sendGmailMessage after the blocked branch");
  const tail = stripComments(s.slice(close, gmail));
  assert.ok(!/\bawait\b/.test(tail), `an await sits between the recheck and Gmail: ${tail.trim().slice(0, 160)}`);
}

const LAST_MOMENT = {
  sendQueue: { claim: `update({ status: "sending" })`, release: "queueReleaseFor(" },
  sendAction: { claim: `update({ status: "sending" })`, release: `to: "approved"` },
  followUp: { claim: ".update({ sequence_step: nextStep", release: "release(pause)" },
} as const;

for (const name of ["sendQueue", "sendAction", "followUp"] as const) {
  test(`${name}: claim → recheck (status + DNC) → Gmail with no await between, and a blocked recheck releases the claim`, () => {
    assertLastMomentShape(src(SEND_PATHS[name]), LAST_MOMENT[name].claim, LAST_MOMENT[name].release);
  });

  test(`${name}: the shape check catches an await slipped in before Gmail`, () => {
    const s = src(SEND_PATHS[name]);
    const gmail = s.indexOf("await sendGmailMessage(");
    const slipped = `${s.slice(0, gmail)}await verifyRecipient(supabase, x);\n  ${s.slice(gmail)}`;
    assert.throws(() => assertLastMomentShape(slipped, LAST_MOMENT[name].claim, LAST_MOMENT[name].release), /an await sits between/);
  });
}

for (const name of ["sendQueue", "sendAction"] as const) {
  test(`${name}: every release from 'sending' is guarded (no bare approved rollback)`, () => {
    const s = src(SEND_PATHS[name]);
    // A direct write back to approved must carry .eq("status", "sending") in the same statement.
    for (const m of s.matchAll(/update\(\{\s*status:\s*"approved"\s*\}\)/g)) {
      const stmt = s.slice(m.index, s.indexOf(";", m.index));
      assert.ok(stmt.includes(`.eq("status", "sending")`), `unguarded rollback: ${stmt.slice(0, 120)}`);
    }
    assert.ok((s.match(/releaseClaim\(/g) ?? []).length >= 3, "token, recheck and send failures all release via releaseClaim");
  });
}

test("sendQueue: the first prospect read fails closed and only a do-not-send status drops", () => {
  const s = src(SEND_PATHS.sendQueue);
  assert.match(s, /error: prospectErr \} = await supabase\s*\n?\s*\.from\("prospects"\)/);
  assert.match(s, /prospectSendBlock\(prospectRow, prospectErr, nowIso\)/);
  assert.match(s, /if \(prospectBlock\.kind === "do_not_send"\) await dropFromQueue/);
});

test("sendAction: a null prospect join does not send", () => {
  const s = src(SEND_PATHS.sendAction);
  assert.match(s, /prospectSendBlock\(pitch\.prospects, null,/);
  assert.ok(!s.includes("?.status ?? null"), "fail-open null join is back");
});

test("follow-up and nudge: a prospect read error is not dropped", () => {
  for (const name of ["followUp", "nudge"] as const) {
    const s = src(SEND_PATHS[name]);
    assert.match(s, /\{ data: prospect, error: prospectErr \}/, `${name} must read the error`);
    assert.match(s, /if \(prospectErr\) \{/, `${name} must act on the error`);
  }
});

test("send-action exports only async functions (it is a \"use server\" file)", () => {
  const s = src(SEND_PATHS.sendAction);
  assert.ok(s.startsWith(`"use server";`));
  const exports = s.match(/^export\s+(?!type\b)(\w+(\s+\w+)?)/gm) ?? [];
  for (const e of exports) assert.match(e, /^export\s+async\s+function/, e);
});

test("canNeverSend: one predicate for queue drop and follow-up pause", () => {
  for (const kind of ["do_not_send", "dnc", "cooldown", "unreadable"] as const) {
    const never = kind === "do_not_send" || kind === "dnc";
    assert.equal(canNeverSend(kind), never, kind);
    assert.equal(followupPausesFor({ kind, reason: "r" }), never, kind);
    assert.equal(queueReleaseFor({ kind, reason: "r" }).to, never ? "auto_rejected" : "approved", kind);
  }
});

test("releaseFollowupClaim logs a failed release instead of dropping it", async () => {
  const logged: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    const failing = { from: () => ({ update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: { message: "boom" } }) }) }) }) };
    await releaseFollowupClaim(failing as unknown as FollowupReleaseClient, {
      pitchId: "pitch-1", claimedStep: 2, priorStep: 1, priorFollowupAt: null, pause: false,
    });
  } finally {
    console.error = orig;
  }
  assert.equal(logged.length, 1);
});
