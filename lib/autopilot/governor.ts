/**
 * The governor: the rules the autopilot can never learn its way around.
 *
 *   laneFor          AUTO / REVIEW / DROP for one pitch. AUTO only when every
 *                    deterministic check passed, the AI reviewer passed, the
 *                    address is verified and the segment isn't on probation.
 *   evaluateBreakers circuit breakers (audit §5.4): what to pause, and why.
 *   nextStage        autonomy stages (off → shadow → veto → auto), promoted
 *                    on measured agreement, demoted automatically on trouble.
 *
 * Learning changes WHAT is said and TO WHOM. It never changes these.
 *
 * Pure — tested in tests/governor.test.ts.
 */

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

/** Addresses we trust enough to send without a person (same set as the gate's). */
const TRUSTED_SOURCES = new Set(["snapverify_smtp", "anymail", "hunter", "manual", "scraper"]);

/** Below this the reviewer's "pass" isn't confident enough to skip a person. */
export const AUTO_MIN_CRITIC_SCORE = 0.8;

export function laneFor(i: LaneInput): { lane: Lane; reasons: string[] } {
  const drop: string[] = [];
  if (i.verify === "drop") drop.push("verifier says the address will not deliver");
  if (i.gate?.failures.some((f) => f.code === "unusable_email")) drop.push("no usable recipient address");
  if (drop.length) return { lane: "drop", reasons: drop };

  const review: string[] = [];
  if (!i.gate) review.push("send gate could not run");
  else for (const f of i.gate.failures) review.push(`gate: ${f.code}`);
  if (!i.critic) review.push("AI review did not run");
  else if (!i.critic.pass) review.push("AI review flagged issues");
  else if (i.critic.score < AUTO_MIN_CRITIC_SCORE) review.push(`AI review score ${i.critic.score.toFixed(2)} < ${AUTO_MIN_CRITIC_SCORE}`);
  if (i.verify !== "send") review.push(i.verify === "review" ? "verifier unsure about the address" : "address not verified yet");
  if (!TRUSTED_SOURCES.has(i.recipientSelectedBy ?? "")) review.push(`address source "${i.recipientSelectedBy ?? "unknown"}" not trusted`);
  if (!i.path.startsWith("claude") && i.path !== "website_claude") review.push("written by a template (templates never go automatically)");
  if (i.segmentOnProbation) review.push("segment on probation after opt-outs");

  return review.length ? { lane: "review", reasons: review } : { lane: "auto", reasons: [] };
}

// ── Held drafts ───────────────────────────────────────────────────────────────

export type HeldAction = { action: "leave"; why: string } | { action: "rewrite" } | { action: "drop"; why: string };

// Reasons a rewrite cannot change: the recipient, or a segment on probation.
const UNFIXABLE_REASON = /^(verifier unsure about the address|address source |segment on probation)/;

/**
 * Nothing waits on a person. A REVIEW draft gets one rewrite when everything
 * that held it is something a rewrite can fix (the reviewer, a template, a
 * writing rule, an address not checked yet), and is dropped otherwise or when
 * the rewrite is held again. A DROP draft is closed at once. Drafts a person
 * edited or pulled back stay theirs.
 */
/**
 * Prefix of every autopilot_reasons entry that means "a person held this after
 * the autopilot scheduled it" (a /pitches veto, a digest hold link). heldAction
 * leaves such a draft alone; every writer of a person-hold reason uses this.
 */
export const HELD_BY_PERSON = "held by a person";

/**
 * Vetoes in the current stage: autopilot-approved pitches a person sent back
 * (current status draft or reviewer_rejected). Counted by the approval event,
 * not the lane: a held pitch is moved to the review lane, so a lane filter
 * would never see it.
 */
export function countVetoes(
  autopilotApproved: ReadonlySet<string>,
  current: ReadonlyArray<{ id: string; status: string }>,
): number {
  const seen = new Set<string>();
  for (const r of current) {
    if (autopilotApproved.has(r.id) && (r.status === "draft" || r.status === "reviewer_rejected")) seen.add(r.id);
  }
  return seen.size;
}

export function heldAction(
  d: { lane: Lane; reasons: string[]; isRewrite: boolean; editedByPerson: boolean },
  writerFixable: ReadonlySet<string>,
): HeldAction {
  if (d.editedByPerson) return { action: "leave", why: "a person edited it" };
  if (d.reasons.some((r) => r.startsWith(HELD_BY_PERSON))) return { action: "leave", why: "a person held it" };
  const why = d.reasons.join("; ") || "held";
  if (d.lane === "drop") return { action: "drop", why };
  if (d.isRewrite) return { action: "drop", why: `still held after one rewrite: ${why}` };
  const unfixable = d.reasons.filter((r) => {
    if (UNFIXABLE_REASON.test(r)) return true;
    const code = r.match(/^gate: (\S+)/)?.[1];
    return code !== undefined && !writerFixable.has(code);
  });
  if (unfixable.length) return { action: "drop", why: `a rewrite can't fix: ${unfixable.join("; ")}` };
  return { action: "rewrite" };
}

// ── Circuit breakers ──────────────────────────────────────────────────────────

export type BreakerMetrics = {
  inboxes: Array<{
    id: string;
    /** Last 50 cold sends from this inbox. */
    recentSends: number;
    recentHardBounces: number;
    /** Gmail API 4xx/5xx or token failures today. */
    apiErrorsToday: number;
  }>;
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

export type BreakerTrip = { scope: "inbox" | "all"; inboxId?: string; code: string; reason: string };

export function evaluateBreakers(m: BreakerMetrics): BreakerTrip[] {
  const trips: BreakerTrip[] = [];
  for (const inbox of m.inboxes) {
    if (inbox.recentSends >= 20 && inbox.recentHardBounces >= 2 && inbox.recentHardBounces / inbox.recentSends >= 0.04) {
      trips.push({
        scope: "inbox",
        inboxId: inbox.id,
        code: "inbox_bounces",
        reason: `${inbox.recentHardBounces} hard bounces in the last ${inbox.recentSends} sends`,
      });
    }
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
  /** Breakers that tripped in this stage where AUTO sends were the cause. */
  autoBreakerTrips: number;
};

export const STAGE_RULES = {
  shadow: { minDays: 7, minDecided: 100, minUneditedRate: 0.9 },
  veto: { minDays: 14, minScheduled: 100, maxVetoRate: 0.05, maxBounceRate: 0.02 },
} as const;

export function nextStage(stage: Stage, m: StageMetrics): { stage: Stage; reason: string } {
  // Demotion first: trouble caused by automatic sends drops a stage at once.
  if ((stage === "auto" || stage === "veto") && (m.autoBreakerTrips > 0 || m.autoFactualErrors > 0)) {
    const down: Stage = stage === "auto" ? "veto" : "shadow";
    return {
      stage: down,
      reason: m.autoBreakerTrips > 0 ? "a circuit breaker tripped on automatic sends" : "an automatic pitch had a factual or recipient error",
    };
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
