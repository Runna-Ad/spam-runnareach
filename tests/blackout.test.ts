import assert from "node:assert/strict";
import test from "node:test";
import { blackoutLabel } from "../lib/discover/blackout-pure.ts";

const SAMPLE_BLACKOUTS = [
  { blackout_date: "2026-07-01", label: "Canada Day" },
  { blackout_date: "2026-12-25", label: "Christmas Day" },
  { blackout_date: "2026-09-16", label: "Día de la Independencia (MX)" },
];

test("blackoutLabel: returns label when date matches", () => {
  const date = new Date("2026-07-01T15:00:00Z");
  assert.equal(blackoutLabel(date, SAMPLE_BLACKOUTS), "Canada Day");
});

test("blackoutLabel: returns null on a normal weekday", () => {
  const date = new Date("2026-07-02T15:00:00Z");
  assert.equal(blackoutLabel(date, SAMPLE_BLACKOUTS), null);
});

test("blackoutLabel: matches by YYYY-MM-DD ignoring time of day", () => {
  const earlyMorning = new Date("2026-12-25T00:00:01Z");
  const lateNight = new Date("2026-12-25T23:59:59Z");
  assert.equal(blackoutLabel(earlyMorning, SAMPLE_BLACKOUTS), "Christmas Day");
  assert.equal(blackoutLabel(lateNight, SAMPLE_BLACKOUTS), "Christmas Day");
});

test("blackoutLabel: finds first match when multiple labels share a date", () => {
  const list = [
    { blackout_date: "2026-07-01", label: "Canada Day" },
    { blackout_date: "2026-07-01", label: "Tenant custom" },
  ];
  assert.equal(blackoutLabel(new Date("2026-07-01"), list), "Canada Day");
});

test("blackoutLabel: empty blackout list always returns null", () => {
  assert.equal(blackoutLabel(new Date("2026-07-01"), []), null);
});

test("blackoutLabel: handles MX-flavored entries", () => {
  const date = new Date("2026-09-16");
  assert.equal(
    blackoutLabel(date, SAMPLE_BLACKOUTS),
    "Día de la Independencia (MX)",
  );
});
