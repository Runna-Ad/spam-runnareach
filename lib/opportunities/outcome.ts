// Pure validation + wording for closing an opportunity as won or lost.
// No server imports: shared by the server actions, the UI and the tests.

import { z } from "zod";

export const OPPORTUNITY_STAGES = [
  "meeting_booked",
  "discovery_done",
  "proposal_sent",
  "negotiation",
  "won",
  "lost",
] as const;

export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export function isClosedStage(stage: string): boolean {
  return stage === "won" || stage === "lost";
}

// numeric(12,2) in the table: 10 integer digits.
const MAX_DEAL_VALUE_CAD = 9_999_999_999.99;

export const wonSchema = z.object({
  id: z.string().uuid(),
  deal_value_cad: z
    .number({
      required_error: "Deal value is required.",
      invalid_type_error: "Deal value must be a number.",
    })
    .finite("Deal value must be a number.")
    .gt(0, "Deal value must be greater than 0.")
    .max(MAX_DEAL_VALUE_CAD, "Deal value is too large.")
    .transform((v) => Math.round(v * 100) / 100),
});

export const lostSchema = z.object({
  id: z.string().uuid(),
  loss_reason: z
    .string({
      required_error: "A loss reason is required.",
      invalid_type_error: "A loss reason is required.",
    })
    .trim()
    .min(1, "A loss reason is required.")
    .transform((s) => s.slice(0, 500)),
});

export type MarkWonInput = z.input<typeof wonSchema>;
export type MarkLostInput = z.input<typeof lostSchema>;

export interface OutcomeFields {
  stage: string;
  deal_value_cad: number | string | null;
  loss_reason: string | null;
  actual_close_date: string | null;
}

const cad = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  maximumFractionDigits: 2,
});

/** One honest line describing how a closed opportunity ended; "" while still open. */
export function describeOutcome(o: OutcomeFields): string {
  const when = o.actual_close_date ? ` on ${o.actual_close_date}` : "";
  if (o.stage === "won") {
    const value = o.deal_value_cad == null ? NaN : Number(o.deal_value_cad);
    return Number.isFinite(value)
      ? `Won${when} for ${cad.format(value)}`
      : `Won${when} (no deal value recorded)`;
  }
  if (o.stage === "lost") {
    const reason = o.loss_reason?.trim();
    return reason ? `Lost${when}: ${reason}` : `Lost${when} (no reason recorded)`;
  }
  return "";
}

/** Today as YYYY-MM-DD (UTC), the value stored in actual_close_date. */
export function closeDateToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
