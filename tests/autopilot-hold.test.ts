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
import { buildVetoDigest, holdPitch, holdStateFor, HOLD_REASON, loadHoldTarget } from "../lib/autopilot/hold.ts";
import { holdExpiry, holdSecret, signHoldToken, verifyHoldToken } from "../lib/autopilot/hold-token.ts";

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

function fakeDb(pitches: Row[], opts: { forbidWrites?: boolean } = {}) {
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
          const hit = matching();
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

test("holdStateFor: only approved is holdable", () => {
  assert.equal(holdStateFor("approved"), "holdable");
  for (const s of ["draft", "sending", "sent", "bounced", "failed", "queued_for_approval", "reviewer_rejected", "auto_rejected"]) {
    assert.notEqual(holdStateFor(s), "holdable");
  }
  assert.equal(holdStateFor(null), "not_found");
});

// ── Digest ───────────────────────────────────────────────────────────────────

const ITEMS = [
  { pitchId: PITCH, company: "Acme Plumbing", subject: "Quick idea for Acme" },
  { pitchId: "44444444-4444-4444-4444-444444444444", company: "Northwind HVAC", subject: "Your booking page" },
];

test("digest: every line gets its own hold link that verifies for its pitch", () => {
  const digest = buildVetoDigest({
    items: ITEMS,
    tenantId: TENANT,
    sendAt: SEND_AT,
    windowHours: 18,
    appUrl: "https://spam-runnareach.vercel.app/",
    secret: SECRET,
  });
  // Printed so the PR body can show a rendered digest (node --test shows stdout).
  console.log(`--- digest subject ---\n${digest.subject}\n--- digest body ---\n${digest.body}\n--- end ---`);
  assert.equal(digest.subject, "Autopilot scheduled 2 emails (sends in 18h unless held)");
  const links = [...digest.body.matchAll(/Hold: (https:\/\/spam-runnareach\.vercel\.app\/api\/autopilot\/hold\?t=(\S+))/g)];
  assert.equal(links.length, 2);
  const ids = links.map((m) => verifyHoldToken(decodeURIComponent(m[2]!), SECRET, NOW)?.pitchId);
  assert.deepEqual(ids, ITEMS.map((i) => i.pitchId));
  assert.match(digest.body, /• Acme Plumbing: "Quick idea for Acme"\n {2}Hold: /);
  assert.match(digest.body, /Holding one counts as a veto/);
  assert.match(digest.body, /https:\/\/spam-runnareach\.vercel\.app\/pitches$/);
});

test("digest without a key: no hold links, /pitches instructions kept", () => {
  const digest = buildVetoDigest({
    items: ITEMS,
    tenantId: TENANT,
    sendAt: SEND_AT,
    windowHours: 18,
    appUrl: "https://spam-runnareach.vercel.app",
    secret: null,
  });
  assert.doesNotMatch(digest.body, /Hold:/);
  assert.doesNotMatch(digest.body, /api\/autopilot\/hold/);
  assert.match(digest.body, /To hold one, move it back to draft on \/pitches before then\./);
  assert.match(digest.body, /• Northwind HVAC: "Your booking page"/);
});

test("digest subject is singular for one email", () => {
  const digest = buildVetoDigest({
    items: ITEMS.slice(0, 1),
    tenantId: TENANT,
    sendAt: SEND_AT,
    windowHours: 18,
    appUrl: "https://x.test",
    secret: SECRET,
  });
  assert.equal(digest.subject, "Autopilot scheduled 1 email (sends in 18h unless held)");
});
