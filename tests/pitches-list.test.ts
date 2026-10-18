import test from "node:test";
import assert from "node:assert/strict";
import { loadHotLeadEvents } from "../lib/pitches/hot-lead-events.ts";
import { hotLeadLevel } from "../lib/pitches/hot-lead.ts";

type Result = { data: unknown[] | null; error: { message: string } | null };
const fake = (result: Result) => ({
  from: () => ({ select: () => ({ eq: () => ({ in: async () => result }) }) }),
});

test("loadHotLeadEvents: query error → no events, unavailable, warns, does not throw", async () => {
  const warns: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a);
  try {
    const r = await loadHotLeadEvents(fake({ data: null, error: { message: "boom" } }), ["p1", "p2"]);
    assert.equal(r.unavailable, true);
    assert.equal(r.eventsByPitch.size, 0);
    assert.equal(hotLeadLevel(r.eventsByPitch.get("p1") ?? []), null);
    assert.deepEqual(warns[0], ["[pitches] hot-lead events not loaded:", "boom"]);
  } finally {
    console.warn = orig;
  }
});

test("loadHotLeadEvents: success groups events by pitch", async () => {
  const ev = { pitch_id: "p1", event_type: "audit_scan", event_at: "2026-10-01T10:00:00Z", payload: { stage: "scan" } };
  const r = await loadHotLeadEvents(fake({ data: [ev, ev], error: null }), ["p1"]);
  assert.equal(r.unavailable, false);
  assert.equal(r.eventsByPitch.get("p1")?.length, 2);
});

test("loadHotLeadEvents: no pitches → no query, available", async () => {
  const r = await loadHotLeadEvents({ from: () => assert.fail("queried") } as never, []);
  assert.equal(r.unavailable, false);
});
