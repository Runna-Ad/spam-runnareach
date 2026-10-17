/** A Gmail rate limit is a pace problem: wait and read the thread again. */

import assert from "node:assert/strict";
import test from "node:test";
import { fetchThreadReplies, isRateLimited } from "../lib/gmail/read.ts";

const QUOTA_BODY =
  '{"error":{"code":403,"message":"Quota exceeded for quota metric \'Total Query Cost\' and limit \'Units per minute per user\' of service \'gmail.googleapis.com\'"}}';

test("per-minute quota and 429 are rate limits; a real 403 is not", () => {
  assert.equal(isRateLimited(403, QUOTA_BODY), true);
  assert.equal(isRateLimited(429, ""), true);
  assert.equal(isRateLimited(403, '{"error":{"message":"Request had insufficient authentication scopes."}}'), false);
  assert.equal(isRateLimited(404, "Not Found"), false);
});

test("a rate-limited read is retried and the reply still comes through", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return new Response(QUOTA_BODY, { status: 403 });
    const from = { name: "From", value: "Ana <ana@example.ca>" };
    const body = Buffer.from("Sí, me interesa").toString("base64url");
    return Response.json({
      id: "t1",
      messages: [{ id: "m1", threadId: "t1", payload: { mimeType: "text/plain", headers: [from], body: { data: body } } }],
    });
  }) as typeof fetch;
  try {
    const r = await fetchThreadReplies("token", "t1", ["henry@runnareach.com"]);
    assert.equal(calls, 2);
    assert.ok(r.ok);
    assert.equal(r.ok && r.replies[0]?.bodyText, "Sí, me interesa");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a real error fails at once, without waiting", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  try {
    const r = await fetchThreadReplies("token", "gone", []);
    assert.equal(calls, 1);
    assert.equal(r.ok, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
