import assert from "node:assert/strict";
import test from "node:test";
import { latestRootSentPitchId } from "../lib/pitches/root-pitch.ts";
import {
  closeDateToday,
  describeOutcome,
  isClosedStage,
  lostSchema,
  wonSchema,
} from "../lib/opportunities/outcome.ts";

const id = "123e4567-e89b-42d3-a456-426614174000";

test("wonSchema: rejects missing, zero, negative and non-finite values", () => {
  assert.equal(wonSchema.safeParse({ id }).success, false);
  assert.equal(wonSchema.safeParse({ id, deal_value_cad: 0 }).success, false);
  assert.equal(wonSchema.safeParse({ id, deal_value_cad: -5 }).success, false);
  assert.equal(wonSchema.safeParse({ id, deal_value_cad: Number.NaN }).success, false);
  assert.equal(wonSchema.safeParse({ id, deal_value_cad: Infinity }).success, false);
  assert.equal(wonSchema.safeParse({ id, deal_value_cad: "5000" }).success, false);
});

test("wonSchema: accepts a positive value and rounds to cents", () => {
  const r = wonSchema.safeParse({ id, deal_value_cad: 1234.567 });
  assert.equal(r.success, true);
  if (r.success) assert.equal(r.data.deal_value_cad, 1234.57);
});

test("wonSchema: rejects a value that overflows numeric(12,2)", () => {
  assert.equal(wonSchema.safeParse({ id, deal_value_cad: 1e12 }).success, false);
});

test("lostSchema: rejects empty, whitespace-only and missing reason", () => {
  assert.equal(lostSchema.safeParse({ id, loss_reason: "" }).success, false);
  assert.equal(lostSchema.safeParse({ id, loss_reason: "   " }).success, false);
  assert.equal(lostSchema.safeParse({ id }).success, false);
});

test("lostSchema: trims and clips a long reason instead of rejecting it", () => {
  const r = lostSchema.safeParse({ id, loss_reason: `  ${"x".repeat(900)}  ` });
  assert.equal(r.success, true);
  if (r.success) assert.equal(r.data.loss_reason.length, 500);
});

test("schemas: reject a non-uuid id", () => {
  assert.equal(wonSchema.safeParse({ id: "nope", deal_value_cad: 10 }).success, false);
  assert.equal(lostSchema.safeParse({ id: "nope", loss_reason: "price" }).success, false);
});

test("describeOutcome: won, lost and open", () => {
  assert.equal(
    describeOutcome({
      stage: "won",
      deal_value_cad: 4500,
      loss_reason: null,
      actual_close_date: "2026-10-17",
    }),
    "Won on 2026-10-17 for $4,500.00",
  );
  assert.equal(
    describeOutcome({
      stage: "won",
      deal_value_cad: null,
      loss_reason: null,
      actual_close_date: null,
    }),
    "Won (no deal value recorded)",
  );
  assert.equal(
    describeOutcome({
      stage: "lost",
      deal_value_cad: null,
      loss_reason: "Chose in-house",
      actual_close_date: "2026-10-17",
    }),
    "Lost on 2026-10-17: Chose in-house",
  );
  assert.equal(
    describeOutcome({
      stage: "lost",
      deal_value_cad: null,
      loss_reason: " ",
      actual_close_date: null,
    }),
    "Lost (no reason recorded)",
  );
  assert.equal(
    describeOutcome({
      stage: "proposal_sent",
      deal_value_cad: null,
      loss_reason: null,
      actual_close_date: null,
    }),
    "",
  );
});

test("isClosedStage / closeDateToday", () => {
  assert.equal(isClosedStage("won"), true);
  assert.equal(isClosedStage("lost"), true);
  assert.equal(isClosedStage("negotiation"), false);
  assert.equal(closeDateToday(new Date("2026-10-17T23:59:59Z")), "2026-10-17");
  // 02:00Z on the 18th is still the evening of the 17th in Toronto (EDT).
  assert.equal(closeDateToday(new Date("2026-10-18T02:00:00Z")), "2026-10-17");
  assert.equal(closeDateToday(new Date("2026-10-18T05:00:00Z")), "2026-10-18");
});

// Minimal in-memory stand-in for the supabase query builder: applies eq / is
// filters and ordering to a fixture so the real lookup runs without a DB.
function fakePitches(rows: Array<Record<string, unknown>>) {
  let out = rows;
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => ((out = out.filter((r) => r[col] === v)), q),
    is: (col: string, v: unknown) => ((out = out.filter((r) => r[col] === v)), q),
    order: (col: string, o: { ascending: boolean }) => {
      out = [...out].sort(
        (a, b) => String(a[col]).localeCompare(String(b[col])) * (o.ascending ? 1 : -1),
      );
      return q;
    },
    limit: (n: number) => ((out = out.slice(0, n)), q),
    maybeSingle: async () => ({ data: out[0] ?? null }),
  };
  return { from: () => q };
}

test("outcome event targets the root pitch, not a later follow-up", async () => {
  const base = { tenant_id: "t1", prospect_id: "p1", status: "sent" };
  const supabase = fakePitches([
    { ...base, id: "root", parent_pitch_id: null, sent_at: "2026-10-01T00:00:00Z" },
    { ...base, id: "followup", parent_pitch_id: "root", sent_at: "2026-10-08T00:00:00Z" },
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = await latestRootSentPitchId(supabase as any, { tenantId: "t1", prospectId: "p1" });
  assert.equal(id, "root");
});
