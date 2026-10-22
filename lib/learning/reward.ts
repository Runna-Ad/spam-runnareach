/**
 * What counts as "it worked": one definition every learner optimizes.
 *
 * A pitch's outcome is read from its pitch_events timeline (sent, audit_scan,
 * reply, bounce, unsubscribe, and the opportunity events meeting_booked, won,
 * lost written on the root pitch). Two numbers come out:
 *
 *   value   0..1, the bandit's reward. The strongest signal wins: a booked
 *           meeting or a deal (won OR lost: the email did its job) = 1, asking
 *           to talk = 1, a positive reply ≈ 1, running the free check = 0.5, a
 *           neutral reply a little, a click on one of the email's tracked
 *           links 0.25 (interest, weaker than running the check), silence or
 *           an opt-out = 0.
 *   points  a weighted score for dashboards and yield ranking, where an
 *           opt-out costs points (it is a real harm, not just silence).
 *
 * Bounces are excluded from message learning (value = null): a bounce says the
 * ADDRESS was bad, not the email. Discovery and the verifier learn from them
 * instead (see `addressOutcome`). An opportunity event outweighs a bounce: a
 * prospect who booked got the message. Test addresses are ignored entirely.
 *
 * Clicks are opt-in (`{ clicks: true }`): only the writer learners read them
 * (armStats, called by learn.ts for writer.evidence / writer.guidance), where
 * arms are random and a corporate link scanner is only noise. The scout, the
 * ICP ranking, exemplars and hunter-signals ignore them: a scanner clicks
 * every link, so there a click would teach which segments sit behind one.
 * A click is never decisive: a pitch with only clicks settles when the window
 * passes, like silence, so a click cannot cut a reply's chance short.
 *
 * An outcome is "settled" once a decisive signal arrives or the attribution
 * window passes; learners only count settled outcomes so a pitch sent an hour
 * ago doesn't read as a failure.
 *
 * Pure — tested in tests/learning.test.ts.
 */

export type OutcomeEvent = {
  type: "sent" | "audit_scan" | "click" | "reply" | "bounce" | "unsubscribe" | "meeting_booked" | "won" | "lost" | string;
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
  won: 40,
  meeting_booked: 20,
  contact_request: 15,
  wants_meeting: 12,
  wants_info: 10,
  scan: 3,
  click: 1,
  not_now: 1,
  wrong_person: 1,
  unclassified: 0.5,
  hard_no: -3,
  unsubscribe: -5,
  lost: 0,
} as const;

/** A click on a tracked link (written on the root pitch by the tracked-links redirect): a small positive, below a scan. */
export const CLICK_VALUE = 0.25;

/** Opportunity events: the email produced a meeting or a deal. Full success, decisive. */
const OPPORTUNITY_EVENT_TYPES = ["meeting_booked", "won", "lost"] as const;
type OpportunityEventType = (typeof OPPORTUNITY_EVENT_TYPES)[number];
const isOpportunityEvent = (type: string): type is OpportunityEventType =>
  (OPPORTUNITY_EVENT_TYPES as readonly string[]).includes(type);

/**
 * The pitch_events types an outcome is read from. Loaders that filter events
 * (the exemplar shortlist) select exactly these, so a new outcome type is one
 * edit here.
 */
export const OUTCOME_EVENT_TYPES: readonly string[] = [
  "sent",
  "reply",
  "audit_scan",
  "click",
  "bounce",
  "unsubscribe",
  ...OPPORTUNITY_EVENT_TYPES,
];

/** Days after the first send before silence counts as a settled "no". */
export const ATTRIBUTION_WINDOW_DAYS = 14;

export type Outcome = {
  /** Bandit reward 0..1; null when the pitch must not teach the writer (bounce without an opportunity, never sent, test). */
  value: number | null;
  points: number;
  status: "pending" | "settled";
  signals: string[];
  negative: boolean;
  sentAt: string | null;
};

export type ScoreOptions = {
  /** Count tracked-link clicks (CLICK_VALUE). Writer learners only; everyone else leaves it off. */
  clicks?: boolean;
};

export function scoreOutcome(events: readonly OutcomeEvent[], now: Date = new Date(), opts: ScoreOptions = {}): Outcome {
  const real = events.filter((e) => !e.payload?.test);
  const sends = real.filter((e) => e.type === "sent").map((e) => e.at).sort();
  const sentAt = sends[0] ?? null;
  const signals: string[] = [];
  let value = 0;
  let points = 0;
  let negative = false;
  let decisive = false;
  let bounced = false;
  let opportunity = false;
  let clicked = false;

  for (const e of real) {
    if (e.type === "audit_scan") {
      const stage = e.payload?.stage === "contact_request" ? "contact_request" : "scan";
      signals.push(stage);
      value = Math.max(value, stage === "contact_request" ? 1 : 0.5);
      points += stage === "contact_request" ? POINTS.contact_request : POINTS.scan;
      if (stage === "contact_request") decisive = true;
    } else if (e.type === "click") {
      // Counted once per pitch: link scanners and repeat opens click many times.
      if (!opts.clicks || clicked) continue;
      clicked = true;
      signals.push("click");
      value = Math.max(value, CLICK_VALUE);
      points += POINTS.click;
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
    } else if (isOpportunityEvent(e.type)) {
      signals.push(e.type);
      value = 1;
      points += POINTS[e.type];
      opportunity = true;
      decisive = true;
    }
  }

  const windowOver =
    sentAt !== null && now.getTime() - new Date(sentAt).getTime() >= ATTRIBUTION_WINDOW_DAYS * 86_400_000;
  const status: Outcome["status"] = sentAt !== null && (decisive || windowOver) ? "settled" : "pending";

  return {
    value: sentAt === null || (bounced && !opportunity) ? null : value,
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
