/** A Gmail rate limit is a pace problem: wait and read the thread again. */

import assert from "node:assert/strict";
import test from "node:test";
import { fetchThreadReplies, isRateLimited, listRecentInboundThreadIds } from "../lib/gmail/read.ts";

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

test("recent inbound threads: one list call per page, spam included, our own mail excluded", async () => {
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (!url.includes("pageToken")) {
      return Response.json({ messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }], nextPageToken: "p2" });
    }
    return Response.json({ messages: [{ id: "m3", threadId: "t1" }] });
  }) as typeof fetch;
  try {
    const r = await listRecentInboundThreadIds("token", 2);
    assert.ok(r.ok);
    assert.deepEqual(r.ok && [...r.threadIds].sort(), ["t1", "t2"]);
    assert.equal(urls.length, 2);
    const q = new URL(urls[0]!).searchParams;
    assert.equal(q.get("q"), "-from:me newer_than:2d");
    assert.equal(q.get("includeSpamTrash"), "true");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("recent inbound threads: a failed list says so, so the poll reads every thread", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("Forbidden", { status: 403 })) as typeof fetch;
  try {
    const r = await listRecentInboundThreadIds("token", 2);
    assert.equal(r.ok, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
