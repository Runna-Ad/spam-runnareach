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
  prospectSendBlock,
  queueReleaseFor,
  recheckBeforeSend,
  releaseClaim,
  type ReleaseClient,
  type SendCheckClient,
} from "../lib/pitches/status-transitions.ts";

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
      if (mode === "select" && failReads[table]) return { data: null, error: { message: failReads[table] } };
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

for (const name of ["sendQueue", "sendAction"] as const) {
  test(`${name}: claim → recheck (status + DNC) → Gmail, and a blocked recheck releases the claim`, () => {
    const s = src(SEND_PATHS[name]);
    const claim = at(s, `update({ status: "sending" })`);
    const recheck = at(s, "recheckBeforeSend(", claim, "recheckBeforeSend after the claim");
    const gmail = at(s, "sendGmailMessage({", recheck, "sendGmailMessage after the recheck");
    // Nothing that waits (token exchange, jitter) sits between the recheck and the send.
    const between = s.slice(recheck, gmail);
    assert.ok(!between.includes("getAccessToken("), "token exchange after the recheck");
    assert.ok(!between.includes("setTimeout"), "jitter sleep after the recheck");
    assert.ok(between.includes("releaseClaim("), "a blocked recheck must release the claim");
    assert.ok(/return|continue/.test(between), "a blocked recheck must not fall through to Gmail");
    if (name === "sendQueue") assert.ok(between.includes("queueReleaseFor("), "queue releases per queueReleaseFor");
    else assert.ok(between.includes(`to: "approved"`), "manual send returns the pitch to approved");
  });

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
