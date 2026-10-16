/**
 * Pre-send guards: "has anyone written back?" (asked of Gmail right before a
 * follow-up or nudge) and "one first email per prospect / address".
 */

import assert from "node:assert/strict";
import test from "node:test";
import { firstTouchConflict, threadBlocksSend } from "../lib/pitches/send-guards.ts";

type Resp = { data: unknown; error?: { message: string } | null };

/** Chainable stand-in for the Supabase query builder; answers per table, in order. */
function fakeSupabase(responses: Record<string, Resp[]>) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
  return {
    calls,
    from(table: string) {
      const rec = { table, ops: [] as Array<[string, unknown[]]> };
      calls.push(rec);
      const q: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              const r = responses[table]?.shift() ?? { data: null, error: null };
              return (resolve: (v: Resp) => void) => resolve({ error: null, ...r });
            }
            return (...args: unknown[]) => {
              rec.ops.push([String(prop), args]);
              return q;
            };
          },
        },
      );
      return q;
    },
  };
}

const OUR = "pedro@runnareach.com";
const SINCE = "2026-10-01T15:00:00.000Z";

function mockThread(messages: Array<{ id: string; from: string; at: string }>, status = 200) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "t1",
        messages: messages.map((m) => ({
          id: m.id,
          threadId: "t1",
          internalDate: String(Date.parse(m.at)),
          payload: { headers: [{ name: "From", value: m.from }, { name: "Subject", value: "Re: hi" }], mimeType: "text/plain", body: { data: "" } },
        })),
      }),
      { status },
    )) as typeof fetch;
}

const args = { tenantId: "t", threadId: "t1", ourEmail: OUR, sinceIso: SINCE };

test("an inbound message the poll hasn't imported blocks the follow-up", async () => {
  mockThread([
    { id: "m0", from: OUR, at: "2026-10-01T15:00:00Z" },
    { id: "m1", from: "Maria <maria@acme.mx>", at: "2026-10-02T10:00:00Z" },
  ]);
  const db = fakeSupabase({ replies: [{ data: [] }] });
  assert.match((await threadBlocksSend(db, "tok", args)) ?? "", /hasn't processed/);
});

test("an imported human reply blocks a follow-up but not a nudge", async () => {
  mockThread([{ id: "m1", from: "maria@acme.mx", at: "2026-10-02T10:00:00Z" }]);
  const known = () => fakeSupabase({ replies: [{ data: [{ gmail_message_id: "m1", intent: "wants_info" }] }] });
  assert.match((await threadBlocksSend(known(), "tok", args)) ?? "", /already replied/);
  mockThread([{ id: "m1", from: "maria@acme.mx", at: "2026-10-02T10:00:00Z" }]);
  assert.equal(await threadBlocksSend(known(), "tok", { ...args, mode: "unseen_only" }), null);
});

test("only our own messages, an imported out-of-office, or older mail → safe", async () => {
  mockThread([{ id: "m0", from: OUR, at: "2026-10-01T15:00:00Z" }]);
  assert.equal(await threadBlocksSend(fakeSupabase({}), "tok", args), null);

  mockThread([{ id: "m2", from: "maria@acme.mx", at: "2026-10-03T10:00:00Z" }]);
  const ooo = fakeSupabase({ replies: [{ data: [{ gmail_message_id: "m2", intent: "auto_reply" }] }] });
  assert.equal(await threadBlocksSend(ooo, "tok", args), null);

  mockThread([{ id: "old", from: "maria@acme.mx", at: "2026-09-01T10:00:00Z" }]);
  assert.equal(await threadBlocksSend(fakeSupabase({}), "tok", args), null);
});

test("fails closed when Gmail can't be read", async () => {
  mockThread([], 500);
  assert.match((await threadBlocksSend(fakeSupabase({}), "tok", args)) ?? "", /Couldn't read the Gmail thread/);
});

test("first-touch: a prospect that already got a first email is a duplicate", async () => {
  const db = fakeSupabase({ pitches: [{ data: [{ id: "p-old" }] }] });
  const reason = await firstTouchConflict(db, { tenantId: "t", prospectId: "pr", pitchId: "p-new", email: "a@b.com" });
  assert.match(reason ?? "", /already got a first email \(pitch p-old\)/);
});

test("first-touch: same address on another prospect row is a duplicate; LIKE wildcards escaped", async () => {
  const db = fakeSupabase({
    pitches: [{ data: [] }, { data: [{ id: "p-dup" }] }],
    prospect_contacts: [{ data: [{ id: "c1" }] }],
  });
  const reason = await firstTouchConflict(db, { tenantId: "t", prospectId: "pr", pitchId: "p-new", email: "john_doe@acme.ca" });
  assert.match(reason ?? "", /john_doe@acme\.ca was already emailed \(pitch p-dup\)/);
  const ilike = db.calls.find((c) => c.table === "prospect_contacts")?.ops.find(([op]) => op === "ilike");
  assert.deepEqual(ilike?.[1], ["email", "john\\_doe@acme.ca"]);
});

test("first-touch: nothing sent before → null", async () => {
  const db = fakeSupabase({ pitches: [{ data: [] }], prospect_contacts: [{ data: [] }] });
  assert.equal(await firstTouchConflict(db, { tenantId: "t", prospectId: "pr", pitchId: "p", email: "a@b.com" }), null);
});
