/**
 * What counts as "it worked": one definition every learner optimizes.
 *
 * A pitch's outcome is read from its pitch_events timeline (sent, audit_scan,
 * reply, bounce, unsubscribe). Two numbers come out:
 *
 *   value   0..1, the bandit's reward. The strongest signal wins: asking to
 *           talk = 1, a positive reply ≈ 1, running the free check = 0.5, a
 *           neutral reply a little, silence or an opt-out = 0.
 *   points  a weighted score for dashboards and yield ranking, where an
 *           opt-out costs points (it is a real harm, not just silence).
 *
 * Bounces are excluded from message learning (value = null): a bounce says the
 * ADDRESS was bad, not the email. Discovery and the verifier learn from them
 * instead (see `addressOutcome`). Test addresses are ignored entirely.
 *
 * An outcome is "settled" once a decisive signal arrives or the attribution
 * window passes; learners only count settled outcomes so a pitch sent an hour
 * ago doesn't read as a failure.
 *
 * Pure — tested in tests/learning.test.ts.
 */

export type OutcomeEvent = {
  type: "sent" | "audit_scan" | "reply" | "bounce" | "unsubscribe" | string;
  at: string;
  payload?: {
    stage?: string;
    intent?: string;
    test?: boolean;
  } | null;
};

/** Reply intents (lib/replies/queries.ts ReplyIntent) → bandit value. */
const REPLY_VALUE: Record<string, number> = {
  wants_meeting: 1,
  wants_info: 0.9,
  not_now: 0.3,
  wrong_person: 0.2,
  unclassified: 0.1,
  auto_reply: 0,
  hard_no: 0,
  bounced: 0,
};

export const POINTS = {
  contact_request: 15,
  wants_meeting: 12,
  wants_info: 10,
  scan: 3,
  not_now: 1,
  wrong_person: 1,
  unclassified: 0.5,
  hard_no: -3,
  unsubscribe: -5,
} as const;

/**
 * The pitch_events types an outcome is read from. Loaders that filter events
 * (the exemplar shortlist) select exactly these, so a new outcome type is one
 * edit here.
 */
export const OUTCOME_EVENT_TYPES: readonly string[] = ["sent", "reply", "audit_scan", "bounce", "unsubscribe"];

/** Days after the first send before silence counts as a settled "no". */
export const ATTRIBUTION_WINDOW_DAYS = 14;

export type Outcome = {
  /** Bandit reward 0..1; null when the pitch must not teach the writer (bounce, never sent, test). */
  value: number | null;
  points: number;
  status: "pending" | "settled";
  signals: string[];
  negative: boolean;
  sentAt: string | null;
};

export function scoreOutcome(events: readonly OutcomeEvent[], now: Date = new Date()): Outcome {
  const real = events.filter((e) => !e.payload?.test);
  const sends = real.filter((e) => e.type === "sent").map((e) => e.at).sort();
  const sentAt = sends[0] ?? null;
  const signals: string[] = [];
  let value = 0;
  let points = 0;
  let negative = false;
  let decisive = false;
  let bounced = false;

  for (const e of real) {
    if (e.type === "audit_scan") {
      const stage = e.payload?.stage === "contact_request" ? "contact_request" : "scan";
      signals.push(stage);
      value = Math.max(value, stage === "contact_request" ? 1 : 0.5);
      points += stage === "contact_request" ? POINTS.contact_request : POINTS.scan;
      if (stage === "contact_request") decisive = true;
    } else if (e.type === "reply") {
      const intent = e.payload?.intent ?? "unclassified";
      signals.push(`reply:${intent}`);
      value = Math.max(value, REPLY_VALUE[intent] ?? 0.1);
      points += (POINTS as Record<string, number>)[intent] ?? 0;
      if (intent === "hard_no") negative = true;
      if (intent !== "auto_reply") decisive = true;
    } else if (e.type === "unsubscribe") {
      signals.push("unsubscribe");
      points += POINTS.unsubscribe;
      negative = true;
      decisive = true;
    } else if (e.type === "bounce") {
      signals.push("bounce");
      bounced = true;
      decisive = true;
    }
  }

  const windowOver =
    sentAt !== null && now.getTime() - new Date(sentAt).getTime() >= ATTRIBUTION_WINDOW_DAYS * 86_400_000;
  const status: Outcome["status"] = sentAt !== null && (decisive || windowOver) ? "settled" : "pending";

  return {
    value: sentAt === null || bounced ? null : value,
    points,
    status,
    signals,
    negative,
    sentAt,
  };
}

/** For discovery and the verifier: did the address work at all? null = not sent yet. */
export function addressOutcome(events: readonly OutcomeEvent[]): "delivered" | "bounced" | null {
  const real = events.filter((e) => !e.payload?.test);
  if (real.some((e) => e.type === "bounce")) return "bounced";
  if (real.some((e) => e.type === "sent")) return "delivered";
  return null;
}
