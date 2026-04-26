/**
 * Heuristic reply intent classifier. Pure function — no I/O.
 *
 * Phase-2 swap: replace classifyReplyHeuristic with a Claude call that
 * returns the same shape. The caller doesn't change.
 */

import type { ReplyIntent, ReplySentiment, ReplyUrgency } from "./queries";

export type ClassifyInput = {
  subject: string | null;
  body_text: string | null;
  from_email: string;
};

export type ClassifyResult = {
  intent: ReplyIntent;
  urgency: ReplyUrgency;
  sentiment: ReplySentiment;
  reasoning: string;
};

/**
 * Substring-pattern matcher. Order matters — we check most-specific
 * intents first (auto_reply, wants_meeting) before falling through to
 * softer signals.
 */
export function classifyReplyHeuristic(input: ClassifyInput): ClassifyResult {
  const haystack = [input.subject ?? "", input.body_text ?? ""]
    .join("\n")
    .toLowerCase();
  const reasonParts: string[] = [];

  // 1) Auto-reply / out-of-office detection (high confidence).
  if (
    /out of (the )?office|automatic reply|auto-reply|on vacation|on leave|i am away|currently away|will be back|out of town|holiday|maternity leave|paternity leave/i.test(
      haystack,
    )
  ) {
    return {
      intent: "auto_reply",
      urgency: "cold",
      sentiment: "neutral",
      reasoning: "Out-of-office phrase detected.",
    };
  }

  // 2) Wrong person / forwarded.
  if (
    /not the right person|wrong person|please remove|please contact|forwarded to|cc:?ing/i.test(
      haystack,
    )
  ) {
    reasonParts.push("Wrong-person/forward language detected.");
    return {
      intent: "wrong_person",
      urgency: "cold",
      sentiment: "neutral",
      reasoning: reasonParts.join(" "),
    };
  }

  // 3) Hard no / unsubscribe.
  if (
    /\bunsubscribe\b|\bremove me\b|\bnot interested\b|\bstop emailing\b|\bdo not contact\b|\bno thanks\b|please stop/i.test(
      haystack,
    )
  ) {
    return {
      intent: "hard_no",
      urgency: "cold",
      sentiment: "negative",
      reasoning: "Unsubscribe / not-interested language detected.",
    };
  }

  // 4) Wants meeting (high signal — specific phrases).
  const meetingHits = [
    /\b(let'?s|let us)\s+(chat|meet|talk|connect)/i,
    /\b(book|schedule|set up)\s+(a|the)?\s*(call|meeting|chat|demo|time)/i,
    /calendly\.com|cal\.com\/|when (are|works|would|do you have)/i,
    /\b(happy|glad|love)\s+to\s+(jump|hop)\s+on/i,
    /(grab|find)\s+(a|some)\s+time/i,
  ];
  if (meetingHits.some((re) => re.test(haystack))) {
    return {
      intent: "wants_meeting",
      urgency: "hot",
      sentiment: "positive",
      reasoning: "Meeting request language detected.",
    };
  }

  // 5) Wants info (curious, send more, send deck).
  const infoHits = [
    /\b(send|share)\s+(me|us|over)?\s+(more|details|info|deck|case stud(?:y|ies)|pricing)/i,
    /\b(curious|interested|tell me more|how does (it|this) work)/i,
    /\b(can you|could you)\s+(send|share|tell)/i,
  ];
  if (infoHits.some((re) => re.test(haystack))) {
    return {
      intent: "wants_info",
      urgency: "warm",
      sentiment: "positive",
      reasoning: "Info-request language detected.",
    };
  }

  // 6) Not now / try again later.
  const laterHits = [
    /not (right )?now|reach out (in|after|next)|circle back|try again (later|in)/i,
    /next (quarter|month|year)|after (q\d|the (holidays|new year|summer))/i,
    /maybe later|too early|too busy/i,
  ];
  if (laterHits.some((re) => re.test(haystack))) {
    return {
      intent: "not_now",
      urgency: "warm",
      sentiment: "neutral",
      reasoning: "Defer-to-later language detected.",
    };
  }

  // Default — leave for human review.
  return {
    intent: "unclassified",
    urgency: null,
    sentiment: null,
    reasoning: "No strong signal — left for human review.",
  };
}
