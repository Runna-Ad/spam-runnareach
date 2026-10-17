/**
 * Write → review → revise.
 *
 * The writer's self-score was the only quality signal, and a writer grading
 * itself agrees with itself. This adds two reviewers that are not the writer:
 *   1. the send gate's content rules (deterministic: invented numbers, client
 *      names, jargon, placeholders, greeting), and
 *   2. an AI critic (a separate Claude call with a fixed rubric) that judges
 *      grounding, relevance, plainness, native language and fit.
 * When either finds a problem, the draft goes back to the writer with the
 * concrete issues, up to MAX_REVISIONS times while time allows (a server
 * action has 60s). The best version wins; the critic's final verdict is kept
 * in the pitch's decision record and shown on /pitches.
 *
 * Never fatal: a critic that times out or fails to parse simply doesn't vote.
 */

import { z } from "zod";
import { ANTHROPIC_HAIKU_MODEL, structuredCall, type ClaudeUsage } from "../anthropic/client.ts";
import { pickAddressContact } from "../research/email-utils.ts";
import { composePitchWithClaude } from "./claude-composer.ts";
import type { CriticVerdict } from "./decision.ts";
import type { ComposedPitch, GeneratorInputs } from "./generator.ts";
import { evaluateSendGate, type GateCode, type GateFailure } from "./send-gate.ts";

export const MAX_REVISIONS = 2;
/** The critic is a fast, cheap judge; the writer stays on the default model. */
export const CRITIC_MODEL = ANTHROPIC_HAIKU_MODEL;

/** Gate codes about the WRITING, which a revision can fix. */
const WRITER_FIXABLE: ReadonlySet<GateCode> = new Set<GateCode>([
  "unsourced_metric",
  "client_name",
  "internal_name",
  "banned_jargon",
  "em_dash",
  "unresolved_placeholder",
  "broken_cta",
  "greeting_mismatch",
  "greeting_not_a_name",
  "missing_subject",
  "empty_body",
]);

/**
 * The send gate's verdict on the writing alone, using only what the writer was
 * given. Recipient provenance and website-fetch rules are left to the real
 * gate at approve/send: they are about data, not prose.
 */
export function writingFailures(input: GeneratorInputs, composed: Pick<ComposedPitch, "subject" | "body">): GateFailure[] {
  const contact = pickAddressContact(input.contacts);
  const prospect = input.prospect as GeneratorInputs["prospect"] & { domain?: string | null };
  const result = evaluateSendGate({
    subject: composed.subject,
    body: composed.body,
    lang: input.prospect.language,
    recipientEmail: contact?.email ?? null,
    recipientFullName: contact?.full_name ?? null,
    recipientSelectedBy: null,
    checkRecipientSource: false,
    companyName: input.prospect.company_name,
    siteName: null,
    domain: prospect.domain ?? null,
    websiteVerified: true,
    evidenceQuotes: [
      ...input.pains.map((p) => p.evidence_quote).filter((q): q is string => Boolean(q)),
      ...(input.prospect.what_they_do ? [input.prospect.what_they_do] : []),
    ],
    benchmarkFigures: input.benchmarks.flatMap((b) => [b.figure, b.statistic, b.publisher]),
    clientNames: [
      ...input.case_studies.map((c) => c.client_name),
      ...input.notable_clients.map((c) => c.name),
    ].filter((n): n is string => typeof n === "string" && n.trim().length > 0),
  });
  if (result.pass) return [];
  return result.failures.filter((f) => WRITER_FIXABLE.has(f.code));
}

// ── The critic ────────────────────────────────────────────────────────────────

const criticSchema = z.object({
  pass: z.boolean(),
  score: z.number().min(0).max(1),
  issues: z
    .array(z.string().trim().min(3).max(600))
    .max(12)
    .default([])
    .transform((a) => a.slice(0, 6).map((s) => s.slice(0, 300))),
});

type CriticResult = { pass: boolean; score: number; issues: string[] };

function criticSystem(lang: "en" | "es"): string {
  const language =
    lang === "es"
      ? "Spanish. Judge it as a native Mexican reader would: anything that reads like a translation, anglicisms, or agency Spanish is a fail."
      : "Canadian English. Anything that reads like American marketing copy, or like a template, is a fail.";
  return `You review a cold email before a person sees it. You did not write it. Be strict and specific: a weak email sent to a real business costs a lead.

Judge ONLY against the payload you are given. Criteria (all must pass for "pass": true):
1. GROUNDED: every claim about the prospect comes from the payload (company, industry, city, what_they_do, tech_stack, pain evidence). Any statistic is one of payload.benchmarks, quoted correctly and framed as its caveat says, never as the sender's own result. No client names. No invented numbers.
2. RELEVANT: the owner of THIS business would see within 5 seconds why it is about them. A hook that could be sent to any company fails.
3. PLAIN: everyday words the owner uses; no jargon, hype, consultant lines or agency language; reads like one person writing to another.
4. LANGUAGE: written natively in ${language}
5. FIT: the greeting matches the recipient (a named person, or the team when there is no name); the ask is low-pressure (the free check, reply only if they want).
6. SHAPE: short intro saying who writes, one hook, one fix, one proof line, one CTA line with a link, sign-off; roughly 60 to 100 words before the sign-off.

Output JSON: {"pass": boolean, "score": number 0..1 (how ready it is to send), "issues": [string]}.
Each issue is a concrete instruction the writer can act on ("Replace 'streamline your intake' with what actually happens for them", "The 7 times figure measured getting a conversation, not winning the client"), at most 6, most important first. Empty when it passes.`;
}

function criticUser(input: GeneratorInputs, composed: Pick<ComposedPitch, "subject" | "body">): string {
  const contact = pickAddressContact(input.contacts);
  const payload = {
    prospect: {
      company_name: input.prospect.company_name,
      industry: input.prospect.industry,
      city: input.prospect.city,
      what_they_do: input.prospect.what_they_do,
      tech_stack: input.prospect.tech_stack,
    },
    pain_evidence: input.pains.map((p) => ({ pain: p.pain_label, evidence: p.evidence_quote })),
    benchmarks: input.benchmarks.map((b) => ({ statistic: b.statistic, figure: b.figure, publisher: b.publisher, caveat: b.caveat ?? null })),
    recipient: contact ? { name: contact.full_name, email: contact.email, role_based: contact.email_is_role_based } : null,
  };
  return `Payload:\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\nEmail to review:\nSubject: ${composed.subject}\n\n${composed.body}`;
}

export async function critiquePitch(
  input: GeneratorInputs,
  composed: Pick<ComposedPitch, "subject" | "body">,
  timeoutMs: number,
): Promise<{ ok: true; verdict: CriticResult; usage: ClaudeUsage } | { ok: false; usage: ClaudeUsage | null }> {
  const call = await structuredCall({
    model: CRITIC_MODEL,
    system: criticSystem(input.prospect.language),
    user: criticUser(input, composed),
    max_tokens: 700,
    timeoutMs,
    schema: criticSchema,
  });
  if (!call.ok) return { ok: false, usage: call.usage };
  // A "pass" with issues listed is not a pass.
  const issues = (call.data.issues ?? []).slice(0, 6).map((i) => i.slice(0, 300));
  const verdict: CriticResult = { pass: call.data.pass && issues.length === 0, score: call.data.score, issues };
  return { ok: true, verdict, usage: call.usage };
}

// ── The loop ──────────────────────────────────────────────────────────────────

export type ReviewCall = { kind: "compose" | "critic"; model: string; usage: ClaudeUsage };

export type ReviewedCompose =
  | { ok: true; composed: ComposedPitch; model: string; critic: CriticVerdict | null; writing: GateFailure[]; calls: ReviewCall[] }
  | { ok: false; error: string; reason: string; calls: ReviewCall[] };

type Candidate = {
  composed: ComposedPitch;
  model: string;
  writing: GateFailure[];
  review: CriticResult | null;
};

/** Lower is better: block-level writing failures, then any failures, then the critic. */
function rank(c: Candidate): [number, number, number, number] {
  const blocks = c.writing.filter((f) => f.severity === "block").length;
  return [blocks, c.writing.length, c.review?.pass ? 0 : 1, -(c.review?.score ?? 0)];
}

export function better(a: Candidate, b: Candidate): Candidate {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i]! < rb[i]!) return a;
    if (ra[i]! > rb[i]!) return b;
  }
  return b; // tie: prefer the newer revision
}

/** Issues to hand back to the writer: the gate's exact findings first, then the critic's. */
export function revisionIssues(c: Pick<Candidate, "writing" | "review">): string[] {
  return [...c.writing.map((f) => f.detail), ...(c.review?.issues ?? [])].slice(0, 8);
}

/**
 * Compose, review, and revise until the draft is clean, MAX_REVISIONS is hit,
 * or the deadline is near. `deadline` is an absolute ms timestamp.
 */
export async function composeWithReview(
  input: GeneratorInputs,
  opts: { deadline: number; maxRevisions?: number; now?: () => number },
): Promise<ReviewedCompose> {
  const now = opts.now ?? Date.now;
  const maxRevisions = opts.maxRevisions ?? MAX_REVISIONS;
  const calls: ReviewCall[] = [];

  const first = await composePitchWithClaude(input);
  if (!first.ok) {
    if (first.usage) calls.push({ kind: "compose", model: "unknown", usage: first.usage });
    return { ok: false, error: first.error, reason: first.reason, calls };
  }
  calls.push({ kind: "compose", model: first.result.model, usage: first.result.usage });

  let current: Candidate = {
    composed: first.result.composed,
    model: first.result.model,
    writing: writingFailures(input, first.result.composed),
    review: null,
  };
  let best: Candidate = current;
  const history: CriticVerdict["history"] = [];
  let revisions = 0;
  let reviewed = false;

  for (;;) {
    const left = opts.deadline - now();
    if (left > 6_000) {
      const r = await critiquePitch(input, current.composed, Math.min(15_000, left - 2_000));
      if (r.usage) calls.push({ kind: "critic", model: CRITIC_MODEL, usage: r.usage });
      if (r.ok) {
        current.review = r.verdict;
        reviewed = true;
        history.push({ pass: r.verdict.pass, score: r.verdict.score, issues: r.verdict.issues });
      }
    }
    best = better(best, current);

    const needsWork = current.writing.length > 0 || (current.review !== null && !current.review.pass);
    const remaining = opts.deadline - now();
    if (!needsWork || revisions >= maxRevisions || remaining < 25_000) break;

    const next = await composePitchWithClaude(
      {
        ...input,
        revision: { subject: current.composed.subject, body: current.composed.body, issues: revisionIssues(current) },
      },
      { timeoutMs: Math.min(30_000, remaining - 8_000) },
    );
    revisions++;
    if (!next.ok) {
      if (next.usage) calls.push({ kind: "compose", model: current.model, usage: next.usage });
      break;
    }
    calls.push({ kind: "compose", model: next.result.model, usage: next.result.usage });
    current = {
      composed: next.result.composed,
      model: next.result.model,
      writing: writingFailures(input, next.result.composed),
      review: null,
    };
    // A revision that is never reviewed (deadline) still competes on the gate.
    best = better(best, current);
  }

  const critic: CriticVerdict | null = reviewed
    ? {
        model: CRITIC_MODEL,
        pass: best.review?.pass ?? false,
        score: best.review?.score ?? 0,
        issues: best.review?.issues ?? ["Not reviewed: the final revision ran out of time."],
        revisions,
        history,
      }
    : null;

  return { ok: true, composed: best.composed, model: best.model, critic, writing: best.writing, calls };
}
