/**
 * Which replies get a drafted answer, and which conversations the nudge cron
 * leaves alone. One list for the poll (auto-draft), the inbox ("Write a reply"
 * button) and the nudge, so they cannot disagree. Pure and client-safe.
 */

import type { ReplyIntent } from "./queries.ts";

/**
 * Intents we draft a response for. Opt-outs, bounces and out-of-office replies
 * are handled by their own routines and never get a draft.
 *
 * wrong_person (Pedro, 2026-11-09): a receptionist who forwarded the email to
 * management did us a favour, so it gets a short thank-you draft instead of
 * only a flag. Like every reply draft, a person approves it before it sends.
 */
export const REPLY_DRAFT_INTENTS: readonly ReplyIntent[] = [
  "wants_meeting",
  "wants_info",
  "not_now",
  "unclassified",
  "wrong_person",
];

export function isDraftableIntent(intent: ReplyIntent | null | undefined): boolean {
  return intent != null && REPLY_DRAFT_INTENTS.includes(intent);
}

/**
 * A thank-you to the wrong person closes that conversation: a "just checking
 * in" nudge three days later would chase a receptionist who already helped.
 */
export function nudgeSkipsIntent(intent: ReplyIntent | null | undefined): boolean {
  return intent === "wrong_person";
}
