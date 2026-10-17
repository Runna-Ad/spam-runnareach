import test from "node:test";
import assert from "node:assert/strict";
import { hotLeadLevel } from "../lib/pitches/hot-lead.ts";

const ev = (event_type: string, event_at: string, stage?: string) => ({
  event_type,
  event_at,
  payload: stage ? { stage } : {},
});

test("hotLeadLevel: no events → null", () => {
  assert.equal(hotLeadLevel([]), null);
});

test("hotLeadLevel: one scan → scan", () => {
  assert.deepEqual(hotLeadLevel([ev("audit_scan", "2026-10-01T10:00:00Z", "scan")]), {
    level: "scan",
    at: "2026-10-01T10:00:00Z",
  });
});

test("hotLeadLevel: scan then contact_request → contact_request with its timestamp", () => {
  const r = hotLeadLevel([
    ev("audit_scan", "2026-10-01T10:00:00Z", "scan"),
    ev("audit_scan", "2026-10-02T09:00:00Z", "contact_request"),
  ]);
  assert.deepEqual(r, { level: "contact_request", at: "2026-10-02T09:00:00Z" });
});

test("hotLeadLevel: contact_request wins even when a later scan exists", () => {
  const r = hotLeadLevel([
    ev("audit_scan", "2026-10-02T09:00:00Z", "contact_request"),
    ev("audit_scan", "2026-10-03T09:00:00Z", "scan"),
  ]);
  assert.deepEqual(r, { level: "contact_request", at: "2026-10-02T09:00:00Z" });
});

test("hotLeadLevel: latest scan wins; input order irrelevant", () => {
  const r = hotLeadLevel([
    ev("audit_scan", "2026-10-03T09:00:00Z", "scan"),
    ev("audit_scan", "2026-10-01T09:00:00Z", "scan"),
  ]);
  assert.deepEqual(r, { level: "scan", at: "2026-10-03T09:00:00Z" });
});

test("hotLeadLevel: other event types and unknown stages are ignored", () => {
  assert.equal(
    hotLeadLevel([
      ev("sent", "2026-10-01T10:00:00Z", "scan"),
      ev("reply", "2026-10-01T11:00:00Z"),
      ev("audit_scan", "2026-10-01T12:00:00Z", "weird"),
      { event_type: "audit_scan", event_at: "2026-10-01T12:00:00Z", payload: null },
    ]),
    null,
  );
});
