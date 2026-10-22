/**
 * The governor: the rules the autopilot can never learn its way around.
 *
 *   laneFor          AUTO / REVIEW / DROP for one pitch. AUTO only when every
 *                    deterministic check passed, the AI reviewer passed, the
 *                    address is verified and the segment isn't on probation.
 *   evaluateBreakers circuit breakers (audit §5.4): what to pause, and why.
 *   nextStage        autonomy stages (off → shadow → veto → auto), promoted
 *                    on measured agreement; when the pitches themselves go
 *                    wrong auto drops to veto and veto restarts its clock
 *                    (never on delivery trouble, never down to shadow).
 *
 * Learning changes WHAT is said and TO WHOM. It never changes these.
 *
 * Pure — tested in tests/governor.test.ts.
 */

import { heldForWriting } from "../learning/presend.ts";
import { isTrustedForAutoSend } from "../research/verify-recipient.ts";

// ── Lanes ─────────────────────────────────────────────────────────────────────

export type Lane = "auto" | "review" | "drop";

export type LaneInput = {
  /** Send-gate verdict on the exact text and recipient. */
  gate: { pass: boolean; failures: Array<{ code: string; severity: "block" | "review" }> } | null;
  /** AI reviewer verdict (lib/pitches/review.ts). */
  critic: { pass: boolean; score: number } | null;
  /** SPAM Verify verdict for the recipient. */
  verify: "send" | "review" | "drop" | null;
  recipientSelectedBy: string | null;
  /** Which writer produced it (decision.path). */
  path: string;
  /** Segment has drawn opt-outs/complaints recently and is held for a person. */
  segmentOnProbation?: boolean;
};

/** Addresses we trust enough to send without a person: the gate's list, from the verifier. */
const TRUSTED_SOURCES = { has: isTrustedForAutoSend };

/** Below this the reviewer's "pass" isn't confident enough to skip a person. */
export const AUTO_MIN_CRITIC_SCORE = 0.8;

export function laneFor(i: LaneInput): { lane: Lane; reasons: string[] } {
  const drop: string[] = [];
  if (i.verify === "drop") drop.push(VERIFIER_DROP_REASON);
  if (i.gate?.failures.some((f) => f.code === "unusable_email")) drop.push("no usable recipient address");
  if (drop.length) return { lane: "drop", reasons: drop };

  const review: string[] = [];
  if (!i.gate) review.push("send gate could not run");
  else for (const f of i.gate.failures) review.push(`gate: ${f.code}`);
  if (!i.critic) review.push("AI review did not run");
  else if (!i.critic.pass) review.push("AI review flagged issues");
  else if (i.critic.score < AUTO_MIN_CRITIC_SCORE) review.push(`AI review score ${i.critic.score.toFixed(2)} < ${AUTO_MIN_CRITIC_SCORE}`);
  if (i.verify !== "send") review.push(i.verify === "review" ? VERIFIER_UNSURE_REASON : "address not verified yet");
  if (!TRUSTED_SOURCES.has(i.recipientSelectedBy ?? "")) review.push(`address source "${i.recipientSelectedBy ?? "unknown"}" not trusted`);
  if (!i.path.startsWith("claude") && i.path !== "website_claude") review.push("written by a template (templates never go automatically)");
  if (i.segmentOnProbation) review.push("segment on probation after opt-outs");

  return review.length ? { lane: "review", reasons: review } : { lane: "auto", reasons: [] };
}

// ── Held drafts ───────────────────────────────────────────────────────────────

export type HeldAction = { action: "leave"; why: string } | { action: "rewrite" } | { action: "drop"; why: string };

// Reasons a rewrite cannot change: the recipient, or a segment on probation.
const UNFIXABLE_REASON = /^(verifier unsure about the address|address source |segment on probation)/;

/** laneFor's reasons about the verifier's verdict on the recipient (exact strings). */
export const VERIFIER_DROP_REASON = "verifier says the address will not deliver";
export const VERIFIER_UNSURE_REASON = "verifier unsure about the address";

/**
 * Prefix of every autopilot_reasons entry that means "a person held this after
 * the autopilot scheduled it" (a /pitches veto, a digest hold link). heldAction
 * leaves such a draft alone; every writer of a person-hold reason uses this.
 */
export const HELD_BY_PERSON = "held by a person";

/**
 * Prefix of every autopilot_reasons entry that means "the autopilot pulled this
 * back itself" (an automatic approval still waiting to send when the stage
 * dropped to shadow or off, or the veto clock restarted, lib/autopilot/hold.ts
 * holdAutoApprovals). Not a
 * person's veto, so it is not HELD_BY_PERSON, but heldAction leaves it alone
 * the same way: what to do with it is a person's call.
 */
export const HELD_BY_AUTOPILOT = "held by the autopilot";

/** The reason a pitch pulled back by a veto clock restart carries (HELD_BY_AUTOPILOT: a person's call next). */
export const VETO_RESTART_HOLD_REASON = `${HELD_BY_AUTOPILOT}: veto clock restarted`;

/**
 * The one test for "a person sent this autopilot approval back": it is back in
 * draft or rejected, and NOT because the autopilot pulled it back itself
 * (HELD_BY_AUTOPILOT: a stage drop or the kill switch). Used by countVetoes
 * (the stage's veto rate) and by the weekly report's "Held by a person".
 */
export function vetoedByPerson(p: { status: string; autopilot_reasons?: readonly string[] | null }): boolean {
  if (p.status !== "draft" && p.status !== "reviewer_rejected") return false;
  return !(p.autopilot_reasons ?? []).some((r) => r.startsWith(HELD_BY_AUTOPILOT));
}

/**
 * Vetoes in the current stage: autopilot-approved pitches a person sent back
 * (vetoedByPerson). Counted by the approval event, not the lane: a held pitch
 * is moved to the review lane, so a lane filter would never see it.
 */
export function countVetoes(
  autopilotApproved: ReadonlySet<string>,
  current: ReadonlyArray<{ id: string; status: string; autopilot_reasons?: readonly string[] | null }>,
): number {
  const seen = new Set<string>();
  for (const r of current) {
    if (autopilotApproved.has(r.id) && vetoedByPerson(r)) seen.add(r.id);
  }
  return seen.size;
}

/**
 * Nothing waits on a person. A REVIEW draft gets one rewrite when everything
 * that held it is something a rewrite can fix (the reviewer, a template, a
 * writing rule, an address not checked yet), and is dropped otherwise or when
 * the rewrite is held again. A DROP draft is closed at once. Drafts a person
 * edited or pulled back stay theirs.
 *
 * The verifier's doubt about the address is fixed by writing to someone else:
 * with `hasAlternativeContact` (the prospect has another usable contact the
 * verifier has not flagged, lib/pitches/contacts.ts hasAlternativeRecipient)
 * an unsure address no longer blocks the rewrite, and a DROP draft whose only
 * reason is the verifier's "will not deliver" is rewritten instead of closed.
 * The rewrite goes to that contact. Without one (or when the contacts could
 * not be read) both drop as before.
 */
export function heldAction(
  d: { lane: Lane; reasons: string[]; isRewrite: boolean; editedByPerson: boolean; hasAlternativeContact?: boolean },
  writerFixable: ReadonlySet<string>,
): HeldAction {
  if (d.editedByPerson) return { action: "leave", why: "a person edited it" };
  if (d.reasons.some((r) => r.startsWith(HELD_BY_PERSON))) return { action: "leave", why: "a person held it" };
  if (d.reasons.some((r) => r.startsWith(VETO_RESTART_HOLD_REASON))) {
    return { action: "leave", why: "the autopilot pulled it back when the veto clock restarted" };
  }
  if (d.reasons.some((r) => r.startsWith(HELD_BY_AUTOPILOT))) {
    return { action: "leave", why: "the autopilot pulled it back when its stage dropped" };
  }
  const why = d.reasons.join("; ") || "held";
  const alternative = d.hasAlternativeContact === true;
  if (d.lane === "drop") {
    const addressOnly = d.reasons.length > 0 && d.reasons.every((r) => r === VERIFIER_DROP_REASON);
    if (!(alternative && addressOnly && !d.isRewrite)) return { action: "drop", why };
  }
  if (d.isRewrite) return { action: "drop", why: `still held after one rewrite: ${why}` };
  const unfixable = d.reasons.filter((r) => {
    if (alternative && r === VERIFIER_UNSURE_REASON) return false;
    if (UNFIXABLE_REASON.test(r)) return true;
    const code = r.match(/^gate: (\S+)/)?.[1];
    return code !== undefined && !writerFixable.has(code);
  });
  if (unfixable.length) return { action: "drop", why: `a rewrite can't fix: ${unfixable.join("; ")}` };
  return { action: "rewrite" };
}

// ── Re-draft pool ─────────────────────────────────────────────────────────────

/** A prospect whose drafts were all thrown away for their writing waits this long for a fresh one. */
export const REDRAFT_AFTER_DAYS = 14;
/** Fresh drafts per tick and per UTC day (each is a full write + review). */
export const REDRAFTS_PER_TICK = 3;
export const REDRAFTS_PER_DAY = 10;
/** decision key on a re-draft (and on its rewrite): the auto_rejected pitch it replaces. */
export const REDRAFT_OF = "redraft_of";
/** decision key on an auto_rejected pitch whose re-draft could not be generated: that was its one try. */
export const REDRAFT_FAILED = "redraft_failed";

/** Prefix dropDraft gives a draft whose rewrite could not be generated (lib/autopilot/tick.ts resolveHeld). */
export const REWRITE_FAILED = "rewrite failed: ";

/**
 * Was this draft thrown away for its writing? The pre-send guardrail's rule
 * (lib/learning/presend.ts heldForWriting: the AI reviewer, writer-fixable
 * gate codes, also after one rewrite), plus a rewrite that could not be
 * generated. Anything about the address, the company, a template, a
 * probation segment, a person or an unknown reason is not.
 */
export function rejectedForWriting(reason: string | null | undefined, writerFixable: ReadonlySet<string>): boolean {
  if (!reason) return false;
  return reason.trim().startsWith(REWRITE_FAILED) || heldForWriting(reason, writerFixable);
}

export type RedraftPitch = {
  id: string;
  status: string;
  created_at: string;
  auto_rejected_reason: string | null;
  decision: Record<string, unknown> | null;
};

/**
 * May the autopilot write this prospect one fresh draft? Every pitch it has
 * (roots and follow-ups) was auto_rejected for its writing, the newest at
 * least REDRAFT_AFTER_DAYS ago, none of them is already a re-draft (or a
 * re-draft that failed to generate), and it has
 * fewer than two: a prospect gets at most two auto_rejected drafts ever. Any
 * other pitch (a draft, an approval, anything sent or sending) means no. The
 * prospect's own status, cooldown and do-not-contact checks are the caller's.
 * Returns the pitch the re-draft replaces (the newest), or null.
 */
export function redraftOf(
  pitches: readonly RedraftPitch[],
  now: Date,
  writerFixable: ReadonlySet<string>,
): string | null {
  if (pitches.length === 0 || pitches.length >= 2) return null;
  if (!pitches.every((p) => p.status === "auto_rejected" && rejectedForWriting(p.auto_rejected_reason, writerFixable))) return null;
  const tried = (d: RedraftPitch["decision"]) =>
    d !== null && typeof d === "object" && (Object.hasOwn(d, REDRAFT_OF) || Object.hasOwn(d, REDRAFT_FAILED));
  if (pitches.some((p) => tried(p.decision))) return null;
  const newest = [...pitches].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]!;
  const age = now.getTime() - Date.parse(newest.created_at);
  if (!(age >= REDRAFT_AFTER_DAYS * 86_400_000)) return null;
  return newest.id;
}

// ── Circuit breakers ──────────────────────────────────────────────────────────

export type BreakerMetrics = {
  inboxes: Array<{
    id: string;
    /** Last 50 cold sends from this inbox. */
    recentSends: number;
    /** Hard bounces among those sends, recorded after the inbox's latest resume (lib/autopilot/bounce-breaker.ts). */
    recentHardBounces: number;
    /** Gmail API 4xx/5xx or token failures today. */
    apiErrorsToday: number;
  }>;
  /** Hard bounces today (UTC), recorded after the latest resume of any inbox today. */
  hardBouncesToday: number;
  /** Opt-outs + hard no's in the last 7 days, and the 30-day weekly average. */
  optOutsThisWeek: number;
  optOutWeeklyBaseline: number;
  /** DMARC pass rate over the last 3 days (null = no reports). */
  dmarcPassRate: number | null;
  blocklisted: boolean;
  /** Warmup inbox placement over the last 7 days (null = not enough checks). */
  warmupInboxRate: number | null;
};

export type BreakerCode = "inbox_bounces" | "gmail_api" | "bounces_today" | "opt_out_spike" | "dmarc" | "blocklist" | "placement";

export type BreakerTrip = { scope: "inbox" | "all"; inboxId?: string; code: BreakerCode; reason: string };

/**
 * What each breaker says about the autopilot. DELIVERY: the mail isn't getting
 * through (dead mailboxes, Gmail, DNS, blocklists, placement): sending pauses,
 * the stage stays. QUALITY: people react to what we send and to whom (opt-outs
 * and hard no's): sending pauses AND the stage drops. The stage measures one
 * thing, whether the pitches are good enough to send without a person
 * (PEDRO_OVERRIDE 2026-10-19). One map, read by nextStage's input (the tick's
 * stage step, lib/autopilot/hold.ts stageQualityTrips); a new code must be
 * classified here or it doesn't compile.
 */
export const BREAKER_KIND: Readonly<Record<BreakerCode, "delivery" | "quality">> = {
  inbox_bounces: "delivery",
  gmail_api: "delivery",
  bounces_today: "delivery",
  dmarc: "delivery",
  blocklist: "delivery",
  placement: "delivery",
  opt_out_spike: "quality",
};

/**
 * Does this breaker insight's code count against the stage? Read from stored
 * evidence, so it takes any value: a code this version doesn't know counts as
 * quality (fails toward a person, never toward more autonomy).
 */
export function isQualityBreaker(code: unknown): boolean {
  if (typeof code === "string" && Object.hasOwn(BREAKER_KIND, code)) return BREAKER_KIND[code as BreakerCode] === "quality";
  return true;
}

/**
 * The inbox_bounces rule, one predicate for both of its users: the tick pauses
 * the inbox on it (evaluateBreakers), and the send-queue skips the inbox for
 * the run on it (lib/autopilot/bounce-breaker.ts inboxBounceBlock), so a drip
 * stops at the first fresh bounce instead of waiting for the next tick.
 */
export function inboxBouncesTrip(inbox: { id: string; recentSends: number; recentHardBounces: number }): BreakerTrip | null {
  if (inbox.recentSends >= 20 && inbox.recentHardBounces >= 2 && inbox.recentHardBounces / inbox.recentSends >= 0.04) {
    return {
      scope: "inbox",
      inboxId: inbox.id,
      code: "inbox_bounces",
      reason: `${inbox.recentHardBounces} hard bounces in the last ${inbox.recentSends} sends`,
    };
  }
  return null;
}

export function evaluateBreakers(m: BreakerMetrics): BreakerTrip[] {
  const trips: BreakerTrip[] = [];
  for (const inbox of m.inboxes) {
    const bounced = inboxBouncesTrip(inbox);
    if (bounced) trips.push(bounced);
    if (inbox.apiErrorsToday >= 3) {
      trips.push({ scope: "inbox", inboxId: inbox.id, code: "gmail_api", reason: `${inbox.apiErrorsToday} Gmail API errors today` });
    }
  }
  if (m.hardBouncesToday >= 3) {
    trips.push({ scope: "all", code: "bounces_today", reason: `${m.hardBouncesToday} hard bounces today` });
  }
  if (m.optOutsThisWeek >= 3 && m.optOutsThisWeek >= 3 * Math.max(m.optOutWeeklyBaseline, 1)) {
    trips.push({
      scope: "all",
      code: "opt_out_spike",
      reason: `${m.optOutsThisWeek} opt-outs this week vs ~${m.optOutWeeklyBaseline.toFixed(1)} normally`,
    });
  }
  if (m.dmarcPassRate !== null && m.dmarcPassRate < 0.9) {
    trips.push({ scope: "all", code: "dmarc", reason: `DMARC pass rate ${(m.dmarcPassRate * 100).toFixed(0)}% (< 90%)` });
  }
  if (m.blocklisted) trips.push({ scope: "all", code: "blocklist", reason: "sending domain is on a blocklist" });
  if (m.warmupInboxRate !== null && m.warmupInboxRate < 0.8) {
    trips.push({
      scope: "all",
      code: "placement",
      reason: `warmup inbox placement ${(m.warmupInboxRate * 100).toFixed(0)}% (< 80%)`,
    });
  }
  return trips;
}

// ── Autonomy stages ───────────────────────────────────────────────────────────

/**
 * off     nothing automatic beyond today's crons.
 * shadow  the autopilot runs the pipeline and labels every pitch; a person
 *         still approves everything. Measures whether its AUTO label agrees
 *         with the person.
 * veto    AUTO pitches are scheduled 12–24h out; a person can hold any.
 * auto    AUTO pitches send; REVIEW still goes to a person.
 */
export type Stage = "off" | "shadow" | "veto" | "auto";

export type StageMetrics = {
  daysInStage: number;
  /** Pitches labelled AUTO in this stage that a person has since decided on. */
  autoDecided: number;
  /** …of which approved with no edit (edit ratio < 5%). */
  autoApprovedUnedited: number;
  /** …of which rejected or vetoed for a factual or recipient error. */
  autoFactualErrors: number;
  /** veto stage: AUTO pitches scheduled, and how many a person held. */
  autoScheduled: number;
  autoVetoed: number;
  /** Hard-bounce rate of AUTO sends in this stage. */
  autoBounceRate: number;
  /** QUALITY breakers (BREAKER_KIND) that tripped in this stage. Delivery trips never count. */
  autoQualityTrips: number;
  /** Their codes, for the demotion reason (lib/autopilot/hold.ts stageQualityTrips). */
  autoQualityTripCodes?: string[];
};

export const STAGE_RULES = {
  shadow: { minDays: 7, minDecided: 100, minUneditedRate: 0.9 },
  veto: { minDays: 14, minScheduled: 100, maxVetoRate: 0.05, maxBounceRate: 0.02 },
} as const;

/** "a quality breaker tripped: opt_out_spike" (each code once, in order of first trip). */
export function qualityTripReason(codes: readonly string[]): string {
  const unique = [...new Set(codes)];
  return unique.length ? `a quality breaker tripped: ${unique.join(", ")}` : "a quality breaker tripped";
}

/**
 * restart: the stage stays where it is but its clock (stage_since) starts
 * again, and automatic approvals still waiting are pulled back as on a
 * demotion. Only veto restarts (see nextStage).
 */
export type StageDecision = { stage: Stage; reason: string; restart?: true };

/**
 * The new stage_since for a stage change or clock restart: the later of the
 * write's own clock and 1 ms after the newest evidence the stage step counted
 * (breaker insights, rejected AUTO pitches; both counted with created_at ≥
 * stage_since). A trip the same tick wrote after the tick's start must not be
 * counted again by the next tick (review of #55: a second restart).
 */
export function stageClockStart(writeAt: Date, evidenceAt: ReadonlyArray<string | null | undefined>): string {
  let t = writeAt.getTime();
  for (const e of evidenceAt) {
    const ms = e ? Date.parse(e) : NaN;
    if (!Number.isNaN(ms) && ms + 1 > t) t = ms + 1;
  }
  return new Date(t).toISOString();
}

export function nextStage(stage: Stage, m: StageMetrics): StageDecision {
  // Pitches going wrong acts at once: auto drops to veto; veto restarts its
  // clock (14 days / 100 scheduled again) and stays veto. Nothing automatic
  // ever moves a tenant to shadow: that is a person's choice only (2026-10-22,
  // shadow needs 100 human approvals to climb back). Delivery trouble pauses
  // sending (the breakers) and never moves the stage.
  if ((stage === "auto" || stage === "veto") && (m.autoQualityTrips > 0 || m.autoFactualErrors > 0)) {
    const why = m.autoFactualErrors > 0 ? "an automatic pitch had a factual or recipient error" : qualityTripReason(m.autoQualityTripCodes ?? []);
    if (stage === "auto") return { stage: "veto", reason: why };
    return { stage: "veto", reason: `${why}; veto clock restarted`, restart: true };
  }

  if (stage === "shadow") {
    const r = STAGE_RULES.shadow;
    const rate = m.autoDecided ? m.autoApprovedUnedited / m.autoDecided : 0;
    if (m.daysInStage >= r.minDays && m.autoDecided >= r.minDecided && rate >= r.minUneditedRate && m.autoFactualErrors === 0) {
      return {
        stage: "veto",
        reason: `${(rate * 100).toFixed(0)}% of ${m.autoDecided} AUTO-labelled pitches approved unedited, no factual errors, ${m.daysInStage} days`,
      };
    }
    return { stage, reason: "collecting agreement" };
  }

  if (stage === "veto") {
    const r = STAGE_RULES.veto;
    const vetoRate = m.autoScheduled ? m.autoVetoed / m.autoScheduled : 1;
    if (m.daysInStage >= r.minDays && m.autoScheduled >= r.minScheduled && vetoRate < r.maxVetoRate && m.autoBounceRate < r.maxBounceRate) {
      return {
        stage: "auto",
        reason: `veto rate ${(vetoRate * 100).toFixed(1)}% over ${m.autoScheduled} scheduled, bounce ${(m.autoBounceRate * 100).toFixed(1)}%, ${m.daysInStage} days`,
      };
    }
    return { stage, reason: "collecting veto data" };
  }

  return { stage, reason: stage === "auto" ? "healthy" : "autopilot off" };
}

/**
 * The autopilot is switched off (kill switch, stage off, or no state row). The
 * tick then runs only its safety steps: the breakers (pause + email, since the
 * send-queue sends approved pitches whatever the stage) and the pull-back of
 * automatic approvals still waiting (lib/autopilot/hold.ts holdAutoApprovals).
 */
export function safetyOnly(s: { enabled: boolean; stage: Stage } | null): boolean {
  return !s || !s.enabled || s.stage === "off";
}
