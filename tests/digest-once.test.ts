/**
 * digest-once: each scheduled autopilot email is listed in exactly one veto
 * digest (Pedro, 2026-10-26: the same prospects in 6-8 digests over a weekend).
 * planVetoDigest is pure; the slot simulation below plays the real slots, the
 * 18h veto window and the weekday sending hours against it. sendVetoDigest
 * (tick.ts, server-only) is checked on its source for the order that keeps a
 * failed send retryable.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  announcedKeys,
  buildVetoDigest,
  DIGEST_HORIZON_HOURS,
  DIGEST_SLOTS_UTC,
  planVetoDigest,
  VETO_WINDOW_HOURS,
  type DigestItem,
  type DigestRecordItem,
} from "../lib/autopilot/hold.ts";

const H = 3_600_000;
const item = (n: number, sendAt: string): DigestItem => ({
  pitchId: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
  company: `Company ${n}`,
  subject: `Idea ${n}`,
  sendAt,
});
const row = (record: DigestRecordItem[]) => ({ metadata: { count: record.length, slot: "x", items: record } });

test("two slots in a row with the same queue: the first lists all, the second lists none", () => {
  const queue = [item(1, "2026-10-27T06:00:00Z"), item(2, "2026-10-27T07:00:00Z")];
  const first = planVetoDigest(queue, []);
  assert.equal(first.fresh.length, 2);
  assert.equal(first.waiting, 0);
  const second = planVetoDigest(queue, [row(first.record)]);
  assert.deepEqual(second.fresh, []);
  assert.equal(second.waiting, 2);
  assert.deepEqual(second.record, [], "the empty slot is recorded with no items");
});

test("a new email between slots: the next digest lists only it, plus the still-waiting line", () => {
  const a = item(1, "2026-10-27T06:00:00Z");
  const b = item(2, "2026-10-27T18:00:00Z");
  const first = planVetoDigest([a], []);
  const second = planVetoDigest([a, b], [row(first.record)]);
  assert.deepEqual(second.fresh.map((i) => i.pitchId), [b.pitchId]);
  assert.equal(second.waiting, 1);
  const digest = buildVetoDigest({ items: second.fresh, waiting: second.waiting, tenantId: "t", appUrl: "https://x.test/", secret: null });
  assert.match(digest.body, /• Company 2: "Idea 2"/);
  assert.doesNotMatch(digest.body, /Company 1/);
  assert.match(
    digest.body,
    /\n1 email from earlier digests is still waiting to send \(sending runs weekdays 15:00-23:00 UTC\): https:\/\/x\.test\/pitches\n/,
  );
});

test("held then re-approved with a new time: listed again once", () => {
  const before = item(1, "2026-10-27T06:00:00Z");
  const after = { ...before, sendAt: "2026-10-28T02:15:00Z" };
  const first = planVetoDigest([before], []);
  const second = planVetoDigest([after], [row(first.record)]);
  assert.equal(second.fresh.length, 1);
  const third = planVetoDigest([after], [row(first.record), row(second.record)]);
  assert.equal(third.fresh.length, 0);
});

test("the same instant in another ISO spelling (Postgres +00:00 vs Z) counts as announced", () => {
  const first = planVetoDigest([item(1, "2026-10-27T06:00:00+00:00")], []);
  assert.equal(planVetoDigest([item(1, "2026-10-27T06:00:00.000Z")], [row(first.record)]).fresh.length, 0);
});

test("digest rows from before this change (no items) announce nothing: listed once more, then not again", () => {
  const queue = [item(1, "2026-10-27T06:00:00Z")];
  const legacy = [{ metadata: { count: 1, slot: "2026-10-26T01:00:00.000Z" } }, { metadata: null }, { metadata: { items: "junk" } }];
  const first = planVetoDigest(queue, legacy);
  assert.equal(first.fresh.length, 1);
  assert.equal(planVetoDigest(queue, [...legacy, row(first.record)]).fresh.length, 0);
});

test("announcedKeys skips malformed entries", () => {
  const keys = announcedKeys([{ metadata: { items: [null, { pitch_id: 3 }, { pitch_id: "p", send_at: "not a date" }, { pitch_id: "p", send_at: "2026-10-27T06:00:00Z" }] } }]);
  assert.equal(keys.size, 1);
});

test("subject and body wording: new emails only, each with its time and hold link; no still-waiting line at 0", () => {
  const items = [item(1, "2026-10-27T06:00:00Z")];
  const digest = buildVetoDigest({ items, waiting: 0, tenantId: "t", appUrl: "https://x.test", secret: "s".repeat(32), now: new Date("2026-10-26T13:00:00Z") });
  assert.equal(digest.subject, "Autopilot: 1 new email scheduled to send (hold any before they go)");
  assert.match(digest.body, /• Company 1: "Idea 1" \(scheduled 2026-10-27 06:00 UTC\)\n {2}Hold: https:\/\/x\.test\/api\/autopilot\/hold\?t=/);
  assert.doesNotMatch(digest.body, /still waiting/);
  assert.doesNotMatch(digest.body, /next 24h|next 24 hours/, "no claim that everything sends within 24h");
  const many = buildVetoDigest({ items: [...items, item(2, "2026-10-27T07:00:00Z")], waiting: 3, tenantId: "t", appUrl: "https://x.test", secret: null });
  assert.equal(many.subject, "Autopilot: 2 new emails scheduled to send (hold any before they go)");
  assert.match(many.body, /3 emails from earlier digests are still waiting to send/);
});

// ── Slot simulation ──────────────────────────────────────────────────────────

/** Sending runs weekdays 15:00-22:59 UTC (send-queue cron); the first run at or after t. */
function firstSendRun(t: number): number {
  for (let u = Math.ceil(t / (10 * 60_000)) * 10 * 60_000; ; u += 10 * 60_000) {
    const d = new Date(u);
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5 && d.getUTCHours() >= 15 && d.getUTCHours() < 23) return u;
  }
}

type Sim = { pitchId: string; sendAt: number; sentAt: number };

/** Runs a digest at every slot from `from` to `to` over the pitches, as sendVetoDigest does. */
function runSlots(pitches: Sim[], from: number, to: number) {
  const rows: Array<{ metadata: unknown }> = [];
  const listed = new Map<string, number[]>();
  const sentDigests: number[] = [];
  for (let day = from - (from % (24 * H)); day <= to; day += 24 * H) {
    for (const h of DIGEST_SLOTS_UTC) {
      const slot = day + h * H;
      if (slot < from || slot > to) continue;
      // Approved at slot time: scheduled already (sendAt - veto window <= slot) and not sent yet.
      const queue = pitches
        .filter((p) => p.sendAt - VETO_WINDOW_HOURS * H <= slot && p.sentAt > slot && p.sendAt <= slot + DIGEST_HORIZON_HOURS * H)
        .map((p, i) => ({ ...item(i, new Date(p.sendAt).toISOString()), pitchId: p.pitchId }));
      const plan = planVetoDigest(queue, rows);
      if (plan.fresh.length > 0) sentDigests.push(slot);
      for (const f of plan.fresh) listed.set(f.pitchId, [...(listed.get(f.pitchId) ?? []), slot]);
      rows.unshift({ metadata: { count: plan.fresh.length, slot: new Date(slot).toISOString(), items: plan.record } });
    }
  }
  return { listed, sentDigests, rows };
}

test("weekend: Friday 13:00 lists X; Sat/Sun/Mon 01:00 digests send nothing for X; X still sends Monday", () => {
  // Scheduled Friday 2026-10-23 09:00 → sendAt Sat 03:00 → first send run Monday 15:00.
  const scheduled = Date.parse("2026-10-23T09:00:00Z");
  const sendAt = scheduled + VETO_WINDOW_HOURS * H;
  const x: Sim = { pitchId: "x", sendAt, sentAt: firstSendRun(sendAt) };
  assert.equal(new Date(x.sentAt).toISOString(), "2026-10-26T15:00:00.000Z");
  const { listed, sentDigests, rows } = runSlots([x], Date.parse("2026-10-23T09:00:00Z"), Date.parse("2026-10-26T14:00:00Z"));
  assert.deepEqual(listed.get("x")!.map((t) => new Date(t).toISOString()), ["2026-10-23T13:00:00.000Z"]);
  assert.deepEqual(sentDigests.map((t) => new Date(t).toISOString()), ["2026-10-23T13:00:00.000Z"]);
  // Every slot was still recorded (empty ones too): Fri 13, Sat 01/13, Sun 01/13, Mon 01/13.
  assert.equal(rows.length, 7);
});

test("property: every email, scheduled at any 15-min tick, is listed in exactly one digest, before it sends", () => {
  const start = Date.parse("2026-10-19T00:00:00Z"); // a Monday
  const pitches: Sim[] = [];
  for (let t = start; t < start + 7 * 24 * H; t += 15 * 60_000) {
    const sendAt = t + VETO_WINDOW_HOURS * H;
    pitches.push({ pitchId: `p${t}`, sendAt, sentAt: firstSendRun(sendAt) });
  }
  const { listed } = runSlots(pitches, start, start + 12 * 24 * H);
  for (const p of pitches) {
    const slots = listed.get(p.pitchId) ?? [];
    assert.equal(slots.length, 1, `${p.pitchId} listed ${slots.length} times`);
    const scheduledAt = p.sendAt - VETO_WINDOW_HOURS * H;
    assert.ok(slots[0]! >= scheduledAt && slots[0]! < p.sendAt, `${new Date(scheduledAt).toISOString()} listed after its send time`);
  }
});

// ── sendVetoDigest wiring (tick.ts is server-only: checked on its source) ────

const tick = readFileSync(new URL("../lib/autopilot/tick.ts", import.meta.url), "utf8");
const fn = tick.slice(tick.indexOf("async function sendVetoDigest"), tick.indexOf("// ── 6. Autonomy stage"));

test("sendVetoDigest: plans against earlier digest rows, mails only fresh ones, records the slot after delivery", () => {
  assert.match(fn, /\.select\("created_at, metadata"\)[\s\S]*\.eq\("action", "autopilot\.digest"\)[\s\S]*\.gte\("created_at", since\)/);
  assert.match(fn, /planVetoDigest\(items, priorDigests\)/);
  assert.match(fn, /if \(plan\.fresh\.length > 0\) \{[\s\S]*buildVetoDigest\(\{ items: plan\.fresh, waiting: plan\.waiting/);
  const notifyAt = fn.indexOf("await notify(");
  const throwAt = fn.indexOf("if (result.sent === 0) throw");
  const insertAt = fn.indexOf('from("audit_log").insert(');
  assert.ok(notifyAt > 0 && throwAt > notifyAt && insertAt > throwAt, "the slot row is written only after the digest reached an inbox");
  assert.match(fn, /metadata: \{ count: plan\.fresh\.length, slot: lastDigestSlot\(now\)\.toISOString\(\), items: plan\.record \}/);
  // The empty slot is recorded: the insert is outside the fresh-only block.
  assert.ok(insertAt > fn.indexOf("\n  }\n", fn.indexOf("if (plan.fresh.length > 0)")));
});
