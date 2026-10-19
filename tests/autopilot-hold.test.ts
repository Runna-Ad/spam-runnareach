/**
 * Veto digest hold links: the signed token, the status-guarded hold, and the
 * digest body. The hold runs against a small fake of the Supabase query builder
 * that applies .eq() filters the way Postgres would, so "only approved rows
 * move" is tested on the filter, not on a mock that returns what we told it to.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "../lib/compliance/unsubscribe-token.ts";
import { buildVetoDigest, DIGEST_HORIZON_HOURS, digestDue, holdPitch, holdStateFor, HOLD_REASON, lastDigestSlot, loadHoldTarget, VETO_WINDOW_HOURS } from "../lib/autopilot/hold.ts";
import { holdExpiry, holdSecret, signHoldToken, verifyHoldToken } from "../lib/autopilot/hold-token.ts";
import { countVetoes, heldAction, HELD_BY_PERSON } from "../lib/autopilot/governor.ts";

const KEY = "base-token-encryption-key";
const SECRET = holdSecret(KEY)!;
const TENANT = "11111111-1111-1111-1111-111111111111";
const PITCH = "33333333-3333-3333-3333-333333333333";
const NOW = new Date("2026-10-18T12:00:00Z");
const SEND_AT = "2026-10-19T06:00:00Z";

// ── Token ────────────────────────────────────────────────────────────────────

test("hold token round-trips", () => {
  const exp = holdExpiry(SEND_AT);
  const token = signHoldToken({ pitchId: PITCH, tenantId: TENANT, exp }, SECRET);
  assert.deepEqual(verifyHoldToken(token, SECRET, NOW), { pitchId: PITCH, tenantId: TENANT, exp });
});

test("expiry is the scheduled send + 24h", () => {
  assert.equal(holdExpiry(SEND_AT) * 1000, new Date("2026-10-20T06:00:00Z").getTime());
  const token = signHoldToken({ pitchId: PITCH, tenantId: TENANT, exp: holdExpiry(SEND_AT) }, SECRET);
  assert.ok(verifyHoldToken(token, SECRET, new Date("2026-10-20T05:59:59Z")));
  assert.equal(verifyHoldToken(token, SECRET, new Date("2026-10-20T06:00:00Z")), null);
});

test("a tampered token fails", () => {
  const token = signHoldToken({ pitchId: PITCH, tenantId: TENANT, exp: holdExpiry(SEND_AT) }, SECRET);
  const [part, mac] = token.split(".") as [string, string];
  const other = Buffer.from(
    JSON.stringify({ v: 1, k: "hold", p: "44444444-4444-4444-4444-444444444444", t: TENANT, exp: holdExpiry(SEND_AT) }),
  ).toString("base64url");
  assert.equal(verifyHoldToken(`${other}.${mac}`, SECRET, NOW), null);
  assert.equal(verifyHoldToken(`${part}.${mac.slice(0, -2)}xx`, SECRET, NOW), null);
  assert.equal(verifyHoldToken(`${part}.${mac}.extra`, SECRET, NOW), null);
  assert.equal(verifyHoldToken("garbage", SECRET, NOW), null);
  assert.equal(verifyHoldToken("", SECRET, NOW), null);
});

test("a token signed with a different key fails", () => {
  const token = signHoldToken({ pitchId: PITCH, tenantId: TENANT, exp: holdExpiry(SEND_AT) }, holdSecret("other-key")!);
  assert.equal(verifyHoldToken(token, SECRET, NOW), null);
});

test("an unsubscribe token never verifies as a hold token, and vice versa", () => {
  // The unsubscribe key as lib/compliance/outbound.ts derives it from the same base key.
  const unsubSecret = createHash("sha256").update(`spam-unsubscribe-v1:${KEY}`).digest("hex");
  assert.notEqual(unsubSecret, SECRET);
  const unsub = signUnsubscribeToken({ tenantId: TENANT, prospectId: PITCH, email: "a@b.co", lang: "en" }, unsubSecret);
  assert.equal(verifyHoldToken(unsub, SECRET, NOW), null);
  // Even signed with the hold key, an unsubscribe-shaped payload is not a hold.
  const unsubUnderHoldKey = signUnsubscribeToken({ tenantId: TENANT, prospectId: PITCH, email: "a@b.co", lang: "en" }, SECRET);
  assert.equal(verifyHoldToken(unsubUnderHoldKey, SECRET, NOW), null);
  // And a hold token is never an unsubscribe token, under either key.
  const hold = signHoldToken({ pitchId: PITCH, tenantId: TENANT, exp: holdExpiry(SEND_AT) }, SECRET);
  assert.equal(verifyUnsubscribeToken(hold, unsubSecret), null);
  assert.equal(verifyUnsubscribeToken(hold, SECRET), null);
});

test("no TOKEN_ENCRYPTION_KEY → no secret (fail closed)", () => {
  assert.equal(holdSecret(undefined), null);
  assert.equal(holdSecret(""), null);
});

// ── Fake db ──────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function fakeDb(pitches: Row[], opts: { forbidWrites?: boolean; updateLosesRace?: boolean } = {}) {
  const audit: Row[] = [];
  const writes: string[] = [];
  const db = {
    audit,
    writes,
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let patch: Row | null = null;
      let returning = false;
      const matching = () => pitches.filter((r) => filters.every(([k, v]) => r[k] === v));
      const run = () => {
        if (patch) {
          // updateLosesRace: the send-queue held the row ('sending') during our update.
          const hit = opts.updateLosesRace ? [] : matching();
          for (const r of hit) Object.assign(r, patch);
          return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
        }
        return { data: matching(), error: null };
      };
      const builder = {
        select() {
          if (patch) returning = true;
          return builder;
        },
        update(values: Row) {
          if (opts.forbidWrites) throw new Error(`write to ${table} on a read-only path`);
          writes.push(table);
          patch = values;
          return builder;
        },
        insert(row: Row) {
          if (opts.forbidWrites) throw new Error(`write to ${table} on a read-only path`);
          writes.push(table);
          if (table === "audit_log") audit.push(row);
          return Promise.resolve({ error: null });
        },
        eq(k: string, v: unknown) {
          filters.push([k, v]);
          return builder;
        },
        maybeSingle() {
          const { data } = run();
          return Promise.resolve({ data: (data as Row[])[0] ?? null, error: null });
        },
        then<T>(resolve: (v: ReturnType<typeof run>) => T) {
          return Promise.resolve(run()).then(resolve);
        },
      };
      return builder;
    },
  };
  return db;
}

function pitch(status: string): Row {
  return {
    id: PITCH,
    tenant_id: TENANT,
    status,
    subject: "Quick idea for Acme",
    scheduled_send_at: SEND_AT,
    queued_at: "2026-10-18T12:00:00Z",
    sender_inbox_id: "inbox-1",
    autopilot_lane: "auto",
    autopilot_reasons: [],
    prospects: { company_name: "Acme Plumbing" },
  };
}

const PAYLOAD = { pitchId: PITCH, tenantId: TENANT, exp: holdExpiry(SEND_AT) };

// ── Hold ─────────────────────────────────────────────────────────────────────

test("an approved pitch is held: draft, schedule cleared, review lane, audited", async () => {
  const row = pitch("approved");
  const db = fakeDb([row]);
  const result = await holdPitch(db, PAYLOAD);
  assert.equal(result.state, "held");
  assert.equal(row.status, "draft");
  assert.equal(row.scheduled_send_at, null);
  assert.equal(row.queued_at, null);
  assert.equal(row.sender_inbox_id, null);
  assert.equal(row.autopilot_lane, "review");
  assert.deepEqual(row.autopilot_reasons, [HOLD_REASON]);
  assert.equal(db.audit.length, 1);
  assert.deepEqual(db.audit[0], {
    tenant_id: TENANT,
    actor_id: null,
    action: "pitch.held",
    entity_type: "pitch",
    entity_id: PITCH,
    metadata: { source: "digest_link" },
  });
});

for (const [status, expected] of [
  ["sent", "already_sent"],
  ["bounced", "already_sent"],
  ["sending", "sending"],
  ["draft", "already_held"],
  ["reviewer_rejected", "not_scheduled"],
  ["auto_rejected", "not_scheduled"],
  ["failed", "not_scheduled"],
] as const) {
  test(`a ${status} pitch is not touched and reports ${expected}`, async () => {
    const row = pitch(status);
    const before = { ...row };
    const db = fakeDb([row]);
    const result = await holdPitch(db, PAYLOAD);
    assert.equal(result.state, expected);
    assert.deepEqual(row, before);
    assert.equal(db.audit.length, 0);
  });
}

test("a second hold on the same pitch reports already held and audits once", async () => {
  const row = pitch("approved");
  const db = fakeDb([row]);
  assert.equal((await holdPitch(db, PAYLOAD)).state, "held");
  assert.equal((await holdPitch(db, PAYLOAD)).state, "already_held");
  assert.equal(db.audit.length, 1);
});

test("a missing pitch, or one in another tenant, reports not found and changes nothing", async () => {
  assert.equal((await holdPitch(fakeDb([]), PAYLOAD)).state, "not_found");
  const row: Row = { ...pitch("approved"), tenant_id: "99999999-9999-9999-9999-999999999999" };
  const db = fakeDb([row]);
  assert.equal((await holdPitch(db, PAYLOAD)).state, "not_found");
  assert.equal(row.status, "approved");
  assert.equal(db.audit.length, 0);
});

test("the GET path (loadHoldTarget) never writes", async () => {
  // forbidWrites makes any update/insert throw.
  const row = pitch("approved");
  const target = await loadHoldTarget(fakeDb([row], { forbidWrites: true }), PAYLOAD);
  assert.deepEqual(target, {
    state: "holdable",
    company: "Acme Plumbing",
    subject: "Quick idea for Acme",
    scheduledSendAt: SEND_AT,
  });
  assert.equal(row.status, "approved");
  assert.equal((await loadHoldTarget(fakeDb([], { forbidWrites: true }), PAYLOAD)).state, "not_found");
});

test("a hold that loses the race to the send-queue says try again, never 'held'", async () => {
  // The guarded update matched nothing; the re-read sees 'approved' again
  // (the queue claimed it, then put it back).
  const row = pitch("approved");
  const db = fakeDb([row], { updateLosesRace: true });
  const result = await holdPitch(db, PAYLOAD);
  assert.equal(result.state, "try_again");
  assert.equal(row.status, "approved");
  assert.equal(db.audit.length, 0);
});

test("a held draft is left alone by the next tick's resolve step (heldAction)", () => {
  assert.ok(HOLD_REASON.startsWith(HELD_BY_PERSON));
  const base = { lane: "review" as const, isRewrite: false, editedByPerson: false };
  assert.equal(heldAction({ ...base, reasons: [HOLD_REASON] }, new Set()).action, "leave");
  assert.equal(heldAction({ ...base, reasons: [HOLD_REASON], isRewrite: true }, new Set()).action, "leave");
  // The reason §5 writes for a /pitches veto, built from the same constant.
  assert.equal(heldAction({ ...base, reasons: [`${HELD_BY_PERSON} after the autopilot scheduled it`] }, new Set()).action, "leave");
});

test("countVetoes: an autopilot-approved pitch back in draft counts, whatever its lane", () => {
  const approved = new Set(["a", "b", "c", "d"]);
  const current = [
    { id: "a", status: "draft" }, // held from the digest (lane review): counts
    { id: "b", status: "reviewer_rejected" }, // rejected after approval: counts
    { id: "c", status: "sent" }, // sent: no
    { id: "d", status: "approved" }, // still queued: no
    { id: "e", status: "draft" }, // never autopilot-approved: no
    { id: "a", status: "draft" }, // duplicate row: counted once
  ];
  assert.equal(countVetoes(approved, current), 2);
  assert.equal(countVetoes(new Set(), current), 0);
});

test("holdStateFor: only approved is holdable", () => {
  assert.equal(holdStateFor("approved"), "holdable");
  for (const s of ["draft", "sending", "sent", "bounced", "failed", "queued_for_approval", "reviewer_rejected", "auto_rejected"]) {
    assert.notEqual(holdStateFor(s), "holdable");
  }
  assert.equal(holdStateFor(null), "not_found");
});

// ── Digest ───────────────────────────────────────────────────────────────────

const ITEMS = [
  { pitchId: PITCH, company: "Acme Plumbing", subject: "Quick idea for Acme", sendAt: SEND_AT },
  { pitchId: "44444444-4444-4444-4444-444444444444", company: "Northwind HVAC", subject: "Your booking page", sendAt: "2026-10-19T09:30:00Z" },
];

test("digest: every line gets its own hold link that verifies for its pitch, with its scheduled time", () => {
  const digest = buildVetoDigest({ items: ITEMS, tenantId: TENANT, appUrl: "https://spam-runnareach.vercel.app/", secret: SECRET, now: NOW });
  // Printed so the PR body can show a rendered digest (node --test shows stdout).
  console.log(`--- digest subject ---\n${digest.subject}\n--- digest body ---\n${digest.body}\n--- end ---`);
  assert.equal(digest.subject, "Autopilot: 2 emails will send in the next 24h unless held");
  const links = [...digest.body.matchAll(/Hold: (https:\/\/spam-runnareach\.vercel\.app\/api\/autopilot\/hold\?t=(\S+))/g)];
  assert.equal(links.length, 2);
  const ids = links.map((m) => verifyHoldToken(decodeURIComponent(m[2]!), SECRET, NOW)?.pitchId);
  assert.deepEqual(ids, ITEMS.map((i) => i.pitchId));
  assert.match(digest.body, /• Acme Plumbing: "Quick idea for Acme" \(scheduled 2026-10-19 06:00 UTC\)\n {2}Hold: /);
  assert.match(digest.body, /• Northwind HVAC: "Your booking page" \(scheduled 2026-10-19 09:30 UTC\)/);
  assert.match(digest.body, /Holding one counts as a veto/);
  assert.match(digest.body, /https:\/\/spam-runnareach\.vercel\.app\/pitches$/);
});

test("digest: each hold link expires 24h after ITS email's send time", () => {
  // The digest is built before the sends (NOW): with the real clock past SEND_AT the
  // email is overdue and its link rightly lives 24h from now instead (next test).
  const digest = buildVetoDigest({ items: ITEMS, tenantId: TENANT, appUrl: "https://x.test", secret: SECRET, now: NOW });
  const tokens = [...digest.body.matchAll(/hold\?t=(\S+)/g)].map((m) => decodeURIComponent(m[1]!));
  assert.ok(verifyHoldToken(tokens[1]!, SECRET, new Date("2026-10-20T09:29:00Z")));
  assert.equal(verifyHoldToken(tokens[0]!, SECRET, new Date("2026-10-20T06:00:00Z")), null);
});

test("digest: an overdue email (waiting for sending hours) still gets a live hold link", () => {
  const overdue = [{ pitchId: PITCH, company: "Acme Plumbing", subject: "Quick idea", sendAt: "2026-10-16T00:30:00Z" }];
  const now = new Date("2026-10-18T13:00:00Z");
  const digest = buildVetoDigest({ items: overdue, tenantId: TENANT, appUrl: "https://x.test", secret: SECRET, now });
  const token = decodeURIComponent(digest.body.match(/hold\?t=(\S+)/)![1]!);
  assert.ok(verifyHoldToken(token, SECRET, new Date("2026-10-19T12:00:00Z")), "valid until 24h after the digest");
  assert.match(digest.body, /Monday to Friday only/);
  assert.doesNotMatch(digest.body, /weekend/);
});

test("digest without a key: no hold links, /pitches instructions kept", () => {
  const digest = buildVetoDigest({ items: ITEMS, tenantId: TENANT, appUrl: "https://spam-runnareach.vercel.app", secret: null, now: NOW });
  assert.doesNotMatch(digest.body, /Hold:/);
  assert.doesNotMatch(digest.body, /api\/autopilot\/hold/);
  assert.match(digest.body, /To hold one, move it back to draft on \/pitches before it sends\./);
  assert.match(digest.body, /• Northwind HVAC: "Your booking page"/);
});

test("digest subject is singular for one email", () => {
  const digest = buildVetoDigest({ items: ITEMS.slice(0, 1), tenantId: TENANT, appUrl: "https://x.test", secret: SECRET, now: NOW });
  assert.equal(digest.subject, "Autopilot: 1 email will send in the next 24h unless held");
});

// ── Digest slots: twice a day, never per tick ────────────────────────────────

test("lastDigestSlot: 01:00 and 13:00 UTC, the most recent at or before now", () => {
  assert.equal(lastDigestSlot(new Date("2026-10-18T15:40:00Z")).toISOString(), "2026-10-18T13:00:00.000Z");
  assert.equal(lastDigestSlot(new Date("2026-10-18T13:00:00Z")).toISOString(), "2026-10-18T13:00:00.000Z");
  assert.equal(lastDigestSlot(new Date("2026-10-18T12:59:00Z")).toISOString(), "2026-10-18T01:00:00.000Z");
  assert.equal(lastDigestSlot(new Date("2026-10-18T00:30:00Z")).toISOString(), "2026-10-17T13:00:00.000Z");
});

test("digestDue: once per slot, every tick after a missed slot catches up", () => {
  const ticks = ["2026-10-18T13:00:00Z", "2026-10-18T13:15:00Z", "2026-10-18T18:00:00Z", "2026-10-19T00:45:00Z"];
  let last: string | null = "2026-10-18T01:00:05Z";
  const sent: string[] = [];
  for (const t of ticks) {
    if (digestDue(new Date(t), last)) { sent.push(t); last = t; }
  }
  assert.deepEqual(sent, ["2026-10-18T13:00:00Z"]);
  // A slot whose ticks all failed: the next tick (even hours later) sends it.
  assert.equal(digestDue(new Date("2026-10-18T16:00:00Z"), "2026-10-18T01:00:05Z"), true);
  assert.equal(digestDue(new Date("2026-10-18T16:00:00Z"), null), true);
});

test("every email scheduled 18h out is listed in at least one digest before it can send", () => {
  // Property over a week of 15-minute ticks: an email scheduled at tick T sends at T+18h;
  // the first digest at or after T (each lists sendAt <= now+24h) must come before T+18h.
  const start = Date.parse("2026-10-18T00:00:00Z");
  for (let t = start; t < start + 7 * 86_400_000; t += 15 * 60_000) {
    const sendAt = t + VETO_WINDOW_HOURS * 3_600_000;
    // The first tick at or after the first slot that falls after the scheduling tick.
    let firstDigest = Number.POSITIVE_INFINITY;
    for (let u = t + 15 * 60_000; u <= sendAt; u += 15 * 60_000) {
      if (lastDigestSlot(new Date(u)).getTime() > t) { firstDigest = u; break; }
    }
    assert.ok(firstDigest < sendAt, `scheduled ${new Date(t).toISOString()} has no digest before ${new Date(sendAt).toISOString()}`);
    assert.ok(sendAt <= firstDigest + DIGEST_HORIZON_HOURS * 3_600_000);
  }
});
