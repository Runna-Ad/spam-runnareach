import "server-only";

/**
 * The learners. Everything here gets better the more the system is used, and
 * every change it makes is an insight with evidence.
 *
 *   chooseWriterArms   called by generatePitch: which variant of the writer to
 *                      use for this pitch (Thompson sampling over arms).
 *   learnFromOutcomes  every tick: recompute each arm's reward from settled
 *                      outcomes; promote winners, retire losers and anything
 *                      that drives opt-outs (bandit.reviewArms).
 *                        writer.evidence  cite a sourced statistic or not
 *                        writer.guidance  learned writing instructions
 *                        scout.cell       ICP × keyword × region searches
 *                      Then the pre-send guardrail (lib/learning/presend.ts):
 *                      a guidance challenger whose drafts the autopilot throws
 *                      away for their writing clearly more often than the
 *                      champion's is retired, days before any reply could say so.
 *   weeklyReview       once a week: an AI review of the week's replies, holds,
 *                      edits, gate failures and arm results proposes up to two
 *                      new writing instructions; each that passes the guidance
 *                      safety check enters live testing as a challenger arm.
 *
 * What learning may never touch (audit §6.4): the gate, compliance, caps,
 * breakers, do-not-contact, the no-invented-numbers rule. Guidance can only add
 * to the writer's rules, and every email still passes the gate and reviewer.
 *
 * Decision 12 (Pedro, 2026-10-22): AI-written guidance is hands-off. It goes
 * live as a challenger and may be promoted or retired with no person in the
 * loop, protected by two guardrails: the pre-send held rate (above) and the
 * opt-out guardrail (bandit.reviewArms). Gates, caps, compliance, breakers and
 * do-not-contact are never learnable.
 */

import { z } from "zod";
import { ANTHROPIC_DEFAULT_MODEL, claudeIsAvailable, structuredCall } from "@/lib/anthropic/client";
import { isUnderDailyCap, recordClaudeCall } from "@/lib/anthropic/cost-tracking";
import { chooseArm, meanReward, reviewArms, type Arm, type ArmAction } from "@/lib/learning/bandit";
import { WRITER_FIXABLE } from "@/lib/pitches/review";
import { armStats, funnelForProspect, GUIDANCE_MAX_CHARS, sanitizeGuidance, type PitchOutcomeInput } from "@/lib/learning/outcomes";
import { hunterDemand, industryScore, proposeCells, type IcpForCells, type IndustryEvidence } from "@/lib/learning/icp";
import {
  PRESEND_REASON,
  PRESEND_WINDOW_DAYS,
  presendGuardrail,
  presendStats,
  type PresendDraft,
  type PresendRetire,
} from "@/lib/learning/presend";
import type { OutcomeEvent } from "@/lib/learning/reward";
import { cellArm, cellKey, prospectReward, scoutCredits } from "@/lib/learning/scout";
import { normalizeIndustry, type SegmentIndustry } from "@/lib/learning/segments";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

const DAY = 86_400_000;
/** Live guidance experiments at once; more spreads traffic too thin. */
const MAX_GUIDANCE_CHALLENGERS = 4;

type ArmRow = {
  learner: string;
  key: string;
  status: Arm["status"];
  reward: number;
  trials: number;
  negatives: number;
  config: Record<string, unknown> | null;
  origin?: string;
  created_at?: string;
};

const toArm = (r: ArmRow): Arm => ({ key: r.key, status: r.status, reward: r.reward, trials: r.trials, negatives: r.negatives });

/** Seed arms: today's behaviour is the champion, the alternative a challenger. */
const SEEDS: Array<{ learner: string; key: string; status: Arm["status"]; config: Record<string, unknown> }> = [
  { learner: "writer.evidence", key: "benchmark", status: "champion", config: { description: "may cite one sourced benchmark" } },
  { learner: "writer.evidence", key: "no_benchmark", status: "challenger", config: { description: "no statistics; their own evidence only" } },
  { learner: "writer.guidance", key: "none", status: "champion", config: { text: null } },
];

export type WriterArms = { evidence: string; guidance: { key: string; text: string } | null };

/** Never throws: with no arms table or any error, today's behaviour. */
export async function chooseWriterArms(db: Db, tenantId: string): Promise<WriterArms> {
  try {
    const { data, error } = await db
      .from("learning_arms")
      .select("learner, key, status, reward, trials, negatives, config")
      .eq("tenant_id", tenantId)
      .in("learner", ["writer.evidence", "writer.guidance"]);
    if (error) return { evidence: "benchmark", guidance: null };
    let rows = (data ?? []) as ArmRow[];
    const missing = SEEDS.filter((s) => !rows.some((r) => r.learner === s.learner));
    if (missing.length) {
      const seed = missing.map((s) => ({ tenant_id: tenantId, learner: s.learner, key: s.key, status: s.status, origin: "seed", config: s.config }));
      await db.from("learning_arms").upsert(seed, { onConflict: "tenant_id,learner,key", ignoreDuplicates: true });
      rows = rows.concat(seed.map((s) => ({ ...s, reward: 0, trials: 0, negatives: 0 }) as ArmRow));
    }
    const pick = (learner: string) => chooseArm(rows.filter((r) => r.learner === learner).map(toArm), { controlShare: 0.2 });
    const evidence = pick("writer.evidence")?.key ?? "benchmark";
    const g = pick("writer.guidance");
    const text = g ? (rows.find((r) => r.learner === "writer.guidance" && r.key === g.key)?.config?.text as string | null) : null;
    return { evidence, guidance: g && text ? { key: g.key, text } : null };
  } catch {
    return { evidence: "benchmark", guidance: null };
  }
}

// ── Outcomes → arms ───────────────────────────────────────────────────────────

async function eventsFor(db: Db, tenantId: string, pitchIds: string[]): Promise<Map<string, OutcomeEvent[]>> {
  const out = new Map<string, OutcomeEvent[]>();
  for (let i = 0; i < pitchIds.length; i += 200) {
    const { data } = await db
      .from("pitch_events")
      .select("pitch_id, event_type, event_at, payload")
      .eq("tenant_id", tenantId)
      .in("pitch_id", pitchIds.slice(i, i + 200));
    for (const e of (data ?? []) as Array<{ pitch_id: string; event_type: string; event_at: string; payload: OutcomeEvent["payload"] }>) {
      const list = out.get(e.pitch_id) ?? [];
      list.push({ type: e.event_type, at: e.event_at, payload: e.payload });
      out.set(e.pitch_id, list);
    }
  }
  return out;
}

async function insight(db: Db, tenantId: string, row: { learner: string; kind: string; title: string; detail?: string; evidence?: unknown }) {
  await db.from("learning_insights").insert({
    tenant_id: tenantId,
    learner: row.learner,
    kind: row.kind,
    title: row.title,
    detail: row.detail ?? null,
    evidence: row.evidence ?? {},
    applied: true,
  });
}

function describe(action: ArmAction): string {
  if (action.kind === "promote") {
    return `promoted "${action.key}" to champion${Number.isFinite(action.pBest) ? ` (${(action.pBest * 100).toFixed(0)}% likely best)` : ""}`;
  }
  return action.reason === "negatives"
    ? `retired "${action.key}": opt-out rate ${((action.negativeRate ?? 0) * 100).toFixed(1)}%`
    : `retired "${action.key}" (${((action.pBest ?? 0) * 100).toFixed(1)}% likely best)`;
}

/** Recompute rewards for one learner's arms, review them, persist, log. */
async function settleLearner(db: Db, tenantId: string, learner: string, totals: Map<string, { reward: number; trials: number; negatives: number }>, minTrials: number) {
  const { data } = await db
    .from("learning_arms")
    .select("learner, key, status, reward, trials, negatives, config")
    .eq("tenant_id", tenantId)
    .eq("learner", learner);
  const rows = (data ?? []) as ArmRow[];
  if (rows.length === 0) return;
  const arms: Arm[] = rows.map((r) => {
    const t = totals.get(r.key);
    return { key: r.key, status: r.status, reward: t?.reward ?? 0, trials: t?.trials ?? 0, negatives: t?.negatives ?? 0 };
  });
  const all = arms.reduce((a, x) => ({ trials: a.trials + x.trials, negatives: a.negatives + (x.negatives ?? 0) }), { trials: 0, negatives: 0 });
  const { actions, arms: next } = reviewArms(arms, {
    minTrials,
    baselineNegativeRate: all.trials ? all.negatives / all.trials : 0,
  });
  const now = new Date().toISOString();
  for (const a of next) {
    const before = rows.find((r) => r.key === a.key)!;
    await db
      .from("learning_arms")
      .update({
        reward: a.reward,
        trials: a.trials,
        negatives: a.negatives ?? 0,
        status: a.status,
        updated_at: now,
        ...(a.status === "retired" && before.status !== "retired" ? { retired_at: now } : {}),
      })
      .eq("tenant_id", tenantId)
      .eq("learner", learner)
      .eq("key", a.key);
  }
  for (const action of actions) {
    await insight(db, tenantId, {
      learner,
      kind: action.kind === "promote" ? "promote" : "retire",
      title: `${learner}: ${describe(action)}`,
      evidence: { action, arms: next.map((a) => ({ key: a.key, status: a.status, trials: a.trials, mean: meanReward(a) })) },
    });
  }
}

export async function learnFromOutcomes(db: Db, tenantId: string, now: Date = new Date()): Promise<void> {
  const since = new Date(now.getTime() - 180 * DAY).toISOString();

  // Writer arms: first emails that recorded their arms.
  const { data: pitchRows } = await db
    .from("pitches")
    .select("id, decision")
    .eq("tenant_id", tenantId)
    .is("parent_pitch_id", null)
    .not("sent_at", "is", null)
    .gte("created_at", since);
  const pitches = ((pitchRows ?? []) as Array<{ id: string; decision: { arms?: Record<string, string> } | null }>).filter(
    (p) => p.decision?.arms,
  );
  const events = await eventsFor(db, tenantId, pitches.map((p) => p.id));
  const inputs: PitchOutcomeInput[] = pitches.map((p) => ({ arms: p.decision?.arms, events: events.get(p.id) ?? [] }));
  for (const learner of ["writer.evidence", "writer.guidance"]) {
    // Only the writer learners count clicks (lib/learning/reward.ts).
    await settleLearner(db, tenantId, learner, armStats(inputs, learner, now, { clicks: true }), 30);
  }
  await presendReview(db, tenantId, now);

  // Scout cells: autopilot discovery jobs and what their crawls' prospects
  // became. Only the stats keys read here: stats also carries processed_ids.
  const { data: jobs } = await db
    .from("discovery_jobs")
    .select("id, status, prospect_ids, created_at, cell_key:stats->focus->>cell_key, new_count:stats->new, found_ids:stats->found_ids")
    .eq("tenant_id", tenantId)
    .not("stats->focus", "is", null)
    .gte("created_at", since)
    .order("created_at", { ascending: true });
  const jobRows = (jobs ?? []) as Array<{
    id: string;
    status: string;
    prospect_ids: string[] | null;
    cell_key: string | null;
    new_count: number | null;
    found_ids: string[] | null;
  }>;
  if (jobRows.length === 0) return;

  const credits = scoutCredits(
    jobRows.flatMap((j) => (j.cell_key ? [{ cellKey: j.cell_key, foundIds: j.found_ids, prospectIds: j.prospect_ids }] : [])),
  );
  const prospectIds = [...credits.values()].flat();
  const statusById = new Map<string, string>();
  const pitchesByProspect = new Map<string, Array<{ id: string; gatePass: boolean; sent: boolean }>>();
  for (let i = 0; i < prospectIds.length; i += 200) {
    const chunk = prospectIds.slice(i, i + 200);
    const [{ data: ps }, { data: pp }] = await Promise.all([
      db.from("prospects").select("id, status").eq("tenant_id", tenantId).in("id", chunk),
      db.from("pitches").select("id, prospect_id, gate_verdict, sent_at").eq("tenant_id", tenantId).is("parent_pitch_id", null).in("prospect_id", chunk),
    ]);
    for (const p of (ps ?? []) as Array<{ id: string; status: string }>) statusById.set(p.id, p.status);
    for (const p of (pp ?? []) as Array<{ id: string; prospect_id: string; gate_verdict: { pass?: boolean } | null; sent_at: string | null }>) {
      const list = pitchesByProspect.get(p.prospect_id) ?? [];
      list.push({ id: p.id, gatePass: p.gate_verdict?.pass === true, sent: Boolean(p.sent_at) });
      pitchesByProspect.set(p.prospect_id, list);
    }
  }
  const sentIds = [...pitchesByProspect.values()].flat().filter((p) => p.sent).map((p) => p.id);
  const scoutEvents = await eventsFor(db, tenantId, sentIds);

  const emptyRuns = new Map<string, number>();
  for (const job of jobRows) {
    const key = job.cell_key;
    if (!key) continue;
    if (job.status === "done") emptyRuns.set(key, (job.new_count ?? 0) === 0 ? (emptyRuns.get(key) ?? 0) + 1 : 0);
  }
  const totals = new Map<string, { reward: number; trials: number; negatives: number }>();
  for (const [key, ids] of credits) {
    const list = ids.map((pid) => {
      const ps = (pitchesByProspect.get(pid) ?? []).map((p) => ({ ...p, events: scoutEvents.get(p.id) ?? [] }));
      return funnelForProspect(statusById.get(pid) ?? "raw", ps, now);
    });
    const a = cellArm({ key, status: "challenger", funnels: list, emptyRuns: 0 });
    totals.set(key, { reward: a.reward, trials: a.trials, negatives: a.negatives ?? 0 });
  }
  await settleLearner(db, tenantId, "scout.cell", totals, 15);
  for (const [key, n] of emptyRuns) {
    const { data: row } = await db.from("learning_arms").select("config").eq("tenant_id", tenantId).eq("learner", "scout.cell").eq("key", key).maybeSingle();
    if (!row) continue;
    await db
      .from("learning_arms")
      .update({ config: { ...(row.config ?? {}), empty_runs: n } })
      .eq("tenant_id", tenantId)
      .eq("learner", "scout.cell")
      .eq("key", key);
  }
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/** The insight title for a pre-send retirement: both rates and counts. */
export function describePresend(r: PresendRetire): string {
  return (
    `writer.guidance: retired "${r.key}": ${r.challenger.held} of ${r.challenger.drafts} drafts thrown away for their writing (${pct(r.challenger.rate)}) ` +
    `vs ${r.champion.held} of ${r.champion.drafts} for the champion "${r.champion.key}" (${pct(r.champion.rate)}), ${pct(r.pWorse)} likely worse`
  );
}

const PRESEND_PAGE = 1000;
const PRESEND_MAX_PAGES = 10;

/**
 * Root drafts created since `since`, newest first, paged past PostgREST's
 * 1000-row cap (ordered by created_at then id so pages never overlap). Only the
 * arms are read out of the decision record. null on any error.
 */
async function presendDrafts(db: Db, tenantId: string, since: string): Promise<PresendDraft[] | null> {
  const out: Array<PresendDraft & { pv: string | null }> = [];
  for (let page = 0; page < PRESEND_MAX_PAGES; page++) {
    const from = page * PRESEND_PAGE;
    const { data, error } = await db
      .from("pitches")
      .select("id, arms:decision->arms, pv:decision->prompt_version, status, auto_rejected_reason")
      .eq("tenant_id", tenantId)
      .is("parent_pitch_id", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PRESEND_PAGE - 1);
    if (error) return null;
    const rows = (data ?? []) as Array<{ arms: Record<string, string> | null; pv: string | null; status: string; auto_rejected_reason: string | null }>;
    out.push(...rows.map((r) => ({ arms: r.arms, pv: r.pv ?? null, status: r.status, auto_rejected_reason: r.auto_rejected_reason })));
    if (rows.length < PRESEND_PAGE) return latestPromptOnly(out);
  }
  return latestPromptOnly(out);
}

/**
 * Only drafts written on the newest writer prompt in the window (rows are newest
 * first). A prompt change shifts every arm's held rate at once while the bandit
 * gives the champion most of the new drafts, so mixing versions would judge a
 * challenger on the old prompt (batch 9 audit). Rows without a version (older
 * records, templates) count only while no versioned row exists.
 */
function latestPromptOnly(rows: Array<PresendDraft & { pv: string | null }>): PresendDraft[] {
  const latest = rows.find((r) => r.pv)?.pv ?? null;
  return rows.filter((r) => latest === null || r.pv === latest).map(({ pv: _pv, ...d }) => d);
}

/**
 * The pre-send guardrail (lib/learning/presend.ts) over the last 14 days of
 * root drafts. Reads the arms after settleLearner wrote them, so a challenger
 * promoted this tick is judged as the champion. The retire is guarded on
 * status = 'challenger': the champion is never touched here.
 */
export async function presendReview(db: Db, tenantId: string, now: Date = new Date()): Promise<PresendRetire[]> {
  const since = new Date(now.getTime() - PRESEND_WINDOW_DAYS * DAY).toISOString();
  const [draftRows, { data: armRows, error: armErr }] = await Promise.all([
    presendDrafts(db, tenantId, since),
    db.from("learning_arms").select("key, status").eq("tenant_id", tenantId).eq("learner", "writer.guidance"),
  ]);
  // Unreadable is not "no drafts": decide nothing this tick.
  if (!draftRows || armErr) return [];
  const drafts: PresendDraft[] = draftRows;
  const arms = (armRows ?? []) as Array<{ key: string; status: string }>;
  const stats = presendStats(drafts, WRITER_FIXABLE);
  const retire = presendGuardrail(arms, stats);
  const at = now.toISOString();
  const done: PresendRetire[] = [];
  for (const r of retire) {
    const { data: updated, error } = await db
      .from("learning_arms")
      .update({ status: "retired", retired_at: at, updated_at: at })
      .eq("tenant_id", tenantId)
      .eq("learner", "writer.guidance")
      .eq("key", r.key)
      .eq("status", "challenger")
      .select("key");
    if (error || ((updated ?? []) as unknown[]).length === 0) continue;
    done.push(r);
    await insight(db, tenantId, {
      learner: "writer.guidance",
      kind: "retire",
      title: describePresend(r),
      evidence: {
        action: { kind: "retire", key: r.key, reason: PRESEND_REASON, pWorse: Number(r.pWorse.toFixed(4)) },
        challenger: r.challenger,
        champion: r.champion,
        window_days: PRESEND_WINDOW_DAYS,
      },
    });
  }
  return done;
}

// ── Smarter ICPs: grow the search space ───────────────────────────────────────

/**
 * Weekly: rank industries by what their prospects became (scout reward) and by
 * organic Hunter demand, then add search cells for the best ones to each
 * active ICP (lib/learning/icp.ts). New cells start as challengers in the
 * scout; they earn traffic only if they pay off.
 */
export async function evolveSearchSpace(db: Db, tenantId: string, now: Date = new Date()): Promise<{ ran: boolean; added: string[] }> {
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const { count: recent } = await db
    .from("learning_insights")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("learner", "icp")
    .gte("created_at", weekAgo);
  if ((recent ?? 0) > 0) return { ran: false, added: [] };

  const since = new Date(now.getTime() - 90 * DAY).toISOString();
  const { data: jobs } = await db
    .from("discovery_jobs")
    .select("prospect_ids, processed_ids:stats->processed_ids")
    .eq("tenant_id", tenantId)
    .gte("created_at", since);
  // prospect_ids is only a job's last list; processed_ids is everything it researched.
  const prospectIds = [
    ...new Set(
      ((jobs ?? []) as Array<{ prospect_ids: string[] | null; processed_ids: string[] | null }>).flatMap((j) => [
        ...(j.processed_ids ?? []),
        ...(j.prospect_ids ?? []),
      ]),
    ),
  ];

  const evidence = new Map<SegmentIndustry, IndustryEvidence>();
  const bump = (ind: SegmentIndustry, reward: number | null, scans = 0) => {
    const e = evidence.get(ind) ?? { reward: 0, trials: 0, hunterScans: 0 };
    if (reward !== null) {
      e.reward += reward;
      e.trials += 1;
    }
    e.hunterScans += scans;
    evidence.set(ind, e);
  };

  for (let i = 0; i < prospectIds.length; i += 200) {
    const chunk = prospectIds.slice(i, i + 200);
    const [{ data: ps }, { data: pp }] = await Promise.all([
      db.from("prospects").select("id, status, industry").eq("tenant_id", tenantId).in("id", chunk),
      db.from("pitches").select("id, prospect_id, gate_verdict, sent_at").eq("tenant_id", tenantId).is("parent_pitch_id", null).in("prospect_id", chunk),
    ]);
    const pitchRows = (pp ?? []) as Array<{ id: string; prospect_id: string; gate_verdict: { pass?: boolean } | null; sent_at: string | null }>;
    const ev = await eventsFor(db, tenantId, pitchRows.filter((p) => p.sent_at).map((p) => p.id));
    for (const p of (ps ?? []) as Array<{ id: string; status: string; industry: string | null }>) {
      const mine = pitchRows
        .filter((x) => x.prospect_id === p.id)
        .map((x) => ({ gatePass: x.gate_verdict?.pass === true, sent: Boolean(x.sent_at), events: ev.get(x.id) ?? [] }));
      bump(normalizeIndustry(p.industry), prospectReward(funnelForProspect(p.status, mine, now)));
    }
  }

  // runna-hunter is a separate app on the shared database: hunter_scans is its table.
  const { data: scans } = await db
    .from("hunter_scans")
    .select("industry")
    .is("ref", null)
    .gte("created_at", new Date(now.getTime() - 60 * DAY).toISOString());
  for (const [ind, n] of hunterDemand((scans ?? []) as Array<{ industry: string | null }>)) bump(ind, null, n);

  const [{ data: icps }, { data: cellRows }] = await Promise.all([
    db.from("icps").select("id, market, search_keywords, geo_regions").eq("tenant_id", tenantId).eq("is_active", true),
    db.from("learning_arms").select("key").eq("tenant_id", tenantId).eq("learner", "scout.cell"),
  ]);
  const proposals = proposeCells({
    icps: (icps ?? []) as IcpForCells[],
    evidence,
    existingKeys: new Set(((cellRows ?? []) as Array<{ key: string }>).map((r) => r.key)),
  });

  const added: string[] = [];
  for (const p of proposals) {
    const key = cellKey(p.cell);
    const { error } = await db.from("learning_arms").insert({
      tenant_id: tenantId,
      learner: "scout.cell",
      key,
      status: "challenger",
      origin: "learner",
      config: { icp_id: p.cell.icpId, keyword: p.cell.keyword, region: p.cell.region, empty_runs: 0, industry: p.industry },
    });
    if (!error) added.push(key);
  }
  await insight(db, tenantId, {
    learner: "icp",
    kind: added.length ? "challenger" : "observation",
    title: added.length ? `Searching ${added.length} new cells where the evidence points` : "No new search cells this week",
    evidence: {
      ranked: [...evidence.entries()]
        .map(([industry, e]) => ({ industry, ...e, score: Number(industryScore(e).toFixed(3)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8),
      added,
    },
  });
  return { ran: true, added };
}

// ── Weekly AI review ──────────────────────────────────────────────────────────

const OBS_TITLE_MAX = 200;
const OBS_EVIDENCE_MAX = 600;
const OBS_MAX = 6;
const GUIDANCE_TEXT_MAX = 400;
const GUIDANCE_WHY_MAX = 400;
const GUIDANCE_MAX = 2;

const clip = (max: number) => (s: string) => s.slice(0, max);
/** The first string among the keys a model tends to use for the same field. */
const field = (o: Record<string, unknown>, keys: string[]): unknown => keys.map((k) => o[k]).find((v) => typeof v === "string");

const observationItem = z.preprocess(
  (v) => (v && typeof v === "object" ? { ...v, title: field(v as Record<string, unknown>, ["title", "observation", "finding", "summary"]) } : v),
  z.object({ title: z.string().min(5).transform(clip(OBS_TITLE_MAX)), evidence: z.string().min(5).transform(clip(OBS_EVIDENCE_MAX)) }),
);
const guidanceItem = z.preprocess(
  (v) => {
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    return { ...o, text: field(o, ["text", "instruction", "guidance"]), why: field(o, ["why", "reason", "rationale"]) };
  },
  // The instruction itself is never clipped: a cut-off instruction could go live.
  z.object({ text: z.string().min(12).max(GUIDANCE_TEXT_MAX), why: z.string().min(5).transform(clip(GUIDANCE_WHY_MAX)) }),
);

/**
 * A list the model filled: items that break a rule are dropped (and counted),
 * long strings are clipped where the rule allows it, extra items cut. A value
 * that is present but not a list counts as one dropped item.
 */
function lenientList<T>(item: z.ZodType<T, z.ZodTypeDef, unknown>, v: unknown, max: number): { items: T[]; dropped: number } {
  if (v === undefined) return { items: [], dropped: 0 };
  if (!Array.isArray(v)) return { items: [], dropped: 1 };
  const items = v.flatMap((x) => {
    const r = item.safeParse(x);
    return r.success ? [r.data] : [];
  });
  return { items: items.slice(0, max), dropped: v.length - items.length };
}

const hasReviewKeys = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v) && ("observations" in (v as object) || "guidance" in (v as object));

/**
 * `{ "review": { observations, guidance } }`, with or without sibling keys:
 * unwrap the one nested object that carries the review's keys.
 */
function unwrapReview(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v) || hasReviewKeys(v)) return v;
  const inner = Object.values(v as Record<string, unknown>).filter(hasReviewKeys);
  return inner.length === 1 ? inner[0] : v;
}

type ReviewOutput = {
  observations: Array<{ title: string; evidence: string }>;
  guidance: Array<{ text: string; why: string }>;
  /** Items the model returned that broke a rule and were left out. */
  dropped: number;
};

// structuredCall types its schema's input as its output; safeParse takes anything.
export const reviewSchema = z.unknown().transform((raw, ctx): ReviewOutput => {
  const v = unwrapReview(raw);
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected a JSON object" });
    return z.NEVER;
  }
  const o = v as Record<string, unknown>;
  const observations = lenientList(observationItem, o.observations, OBS_MAX);
  const guidance = lenientList(guidanceItem, o.guidance, GUIDANCE_MAX);
  // An object with neither key is not an empty week: it must not close the week.
  const missing = hasReviewKeys(o) ? 0 : 1;
  return { observations: observations.items, guidance: guidance.items, dropped: observations.dropped + guidance.dropped + missing };
}) as unknown as z.ZodType<ReviewOutput>;

const REVIEW_SYSTEM = `You improve an automated cold-email writer for Rünna (Runna Advertising), a Mexico/Canada agency that helps small and mid-size businesses with marketing and automation. Emails link to a free audit tool (the Inefficiency Hunter).

Each week you read what happened: replies (with intent), emails a person held back or rejected and why, how people edited drafts, which checks failed, and how the current writing variants performed. You return:
- observations: what the evidence shows, each with the specific evidence ("4 of 6 replies asked what the audit costs").
- guidance: at most 2 NEW one-sentence writing instructions worth testing on live emails, each tied to the evidence. They will be A/B tested against the current writer, so only propose what the evidence suggests could beat it.

Hard limits (an instruction that breaks one is discarded):
- no numbers or statistics of any kind; never suggest claiming results;
- never relax or contradict the writer's rules (no client names, no invented facts, plain words, short emails, one link to the free audit);
- plain language, no marketing jargon;
- an instruction about HOW to write, not about a specific prospect.
If the evidence is too thin to support a new instruction, return an empty guidance list.

Return exactly this JSON shape:
{"observations": [{"title": "...", "evidence": "..."}], "guidance": [{"text": "...", "why": "..."}]}
Limits: up to ${OBS_MAX} observations (title under ${OBS_TITLE_MAX} characters, evidence under ${OBS_EVIDENCE_MAX}); up to ${GUIDANCE_MAX} guidance items (text one sentence under ${GUIDANCE_MAX_CHARS} characters, why under ${GUIDANCE_WHY_MAX}).`;

/**
 * Each paid review attempt leaves this row BEFORE the call, so a call that
 * fails (or a function killed mid-call) still counts: at most one paid attempt
 * per 24 h whatever goes wrong. Its own learner, so a failure does not count as
 * "reviewed this week"; a success writes `review` rows as before.
 */
export const REVIEW_ATTEMPT_LEARNER = "review.attempt";

type ReviewDeps = {
  call: typeof structuredCall;
  claudeAvailable: typeof claudeIsAvailable;
  underCap: typeof isUnderDailyCap;
  record: typeof recordClaudeCall;
};
const REVIEW_DEPS: ReviewDeps = { call: structuredCall, claudeAvailable: claudeIsAvailable, underCap: isUnderDailyCap, record: recordClaudeCall };

/**
 * What a failed call says, for a person: the reason and the error's first
 * ~300 characters. A JSON parse error is cut at its first quote, which drops
 * the model's raw output and the snippet JSON.parse quotes (the output can
 * quote prospect replies); an API or schema error is kept as is (zod
 * messages carry paths, not values).
 */
export function reviewFailureText(error: string): string {
  if (!error.startsWith("JSON parse failed")) return error.slice(0, 300);
  // Fail closed: nothing after the first quote survives (quotes in model text
  // don't pair, so masking quoted spans let text through).
  const cut = error.replace(/\.?\s*Raw:[\s\S]*$/, "");
  return (cut.split('"')[0] ?? "").trimEnd().slice(0, 300);
}

/**
 * Every auto_rejected reason, split into its parts (heldAction joins them with
 * "; " behind a "still held after one rewrite" / "a rewrite can't fix" prefix)
 * and counted, most common first: what the weekly review reads as the main
 * cause of thrown-away drafts.
 */
export function groupRejectionReasons(rows: ReadonlyArray<{ auto_rejected_reason: string | null }>, max = 12): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const text = (r.auto_rejected_reason ?? "").trim() || "no reason recorded";
    const body = text.replace(/^(still held after one rewrite|a rewrite can't fix|rewrite failed): /, "");
    const parts = text.startsWith("rewrite failed: ") ? ["rewrite failed"] : body.split("; ").map((p) => p.trim()).filter(Boolean);
    for (const p of new Set(parts)) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts]
    .map(([reason, count]) => ({ reason: reason.slice(0, 160), count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, max);
}

/**
 * At most one successful review a week and one paid attempt a day, and only
 * with something to learn from. Returns what was created.
 */
export async function weeklyReview(
  db: Db,
  tenantId: string,
  now: Date = new Date(),
  deps: ReviewDeps = REVIEW_DEPS,
): Promise<{ ran: boolean; reason: string; guidance: string[] }> {
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const { count: recent, error: recentError } = await db
    .from("learning_insights")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("learner", "review")
    .gte("created_at", weekAgo);
  if (recentError) return { ran: false, reason: "could not read this week's reviews", guidance: [] };
  if ((recent ?? 0) > 0) return { ran: false, reason: "reviewed this week", guidance: [] };

  const { data: lastAttempt, error: attemptReadError } = await db
    .from("learning_insights")
    .select("created_at")
    .eq("tenant_id", tenantId)
    .eq("learner", REVIEW_ATTEMPT_LEARNER)
    .gte("created_at", new Date(now.getTime() - DAY).toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  if (attemptReadError) return { ran: false, reason: "could not read the last review attempt", guidance: [] };
  const last = ((lastAttempt ?? []) as Array<{ created_at: string }>)[0];
  if (last) {
    const next = new Date(new Date(last.created_at).getTime() + DAY).toISOString();
    return { ran: false, reason: `review attempted in the last 24 h; next try after ${next}`, guidance: [] };
  }

  const since = new Date(now.getTime() - 14 * DAY).toISOString();
  const { count: sent } = await db
    .from("pitches")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .is("parent_pitch_id", null)
    .gte("sent_at", since);
  if ((sent ?? 0) < 10) return { ran: false, reason: `only ${sent ?? 0} emails sent in 14 days`, guidance: [] };
  if (!deps.claudeAvailable()) return { ran: false, reason: "Claude unavailable", guidance: [] };
  const cap = await deps.underCap(tenantId);
  if (!cap.under) return { ran: false, reason: "daily AI cap reached", guidance: [] };

  // Held drafts: the 20 newest as examples, plus every auto_rejected reason
  // counted, so the review sees the main cause and not just a sample of it.
  // Windowed on created_at: updated_at moves on every write (core rule).
  const [{ data: replies }, { data: held }, { data: rejectedReasons }, { data: edited }, { data: drafts }, { data: arms }] = await Promise.all([
    db.from("replies").select("intent, body_text").eq("tenant_id", tenantId).gte("received_at", since).limit(40),
    db.from("pitches").select("subject, rejection_reason, auto_rejected_reason, autopilot_reasons, status").eq("tenant_id", tenantId).in("status", ["reviewer_rejected", "auto_rejected"]).gte("created_at", since).order("created_at", { ascending: false }).limit(20),
    db.from("pitches").select("auto_rejected_reason").eq("tenant_id", tenantId).eq("status", "auto_rejected").gte("created_at", since).limit(2000),
    db.from("pitches").select("body_original, body_edited").eq("tenant_id", tenantId).not("body_edited", "is", null).gte("updated_at", since).limit(8),
    db.from("pitches").select("gate_verdict, decision").eq("tenant_id", tenantId).gte("created_at", since).limit(200),
    db.from("learning_arms").select("learner, key, status, reward, trials, negatives, config").eq("tenant_id", tenantId).neq("status", "retired"),
  ]);

  const gateCodes = new Map<string, number>();
  const criticIssues: string[] = [];
  for (const d of (drafts ?? []) as Array<{ gate_verdict: { failures?: Array<{ code: string }> } | null; decision: { critic?: { issues?: string[] } | null } | null }>) {
    for (const f of d.gate_verdict?.failures ?? []) gateCodes.set(f.code, (gateCodes.get(f.code) ?? 0) + 1);
    criticIssues.push(...(d.decision?.critic?.issues ?? []).slice(0, 2));
  }
  const evidence = {
    replies: ((replies ?? []) as Array<{ intent: string | null; body_text: string | null }>).map((r) => ({
      intent: r.intent,
      text: (r.body_text ?? "").slice(0, 400),
    })),
    held_or_rejected: held ?? [],
    auto_rejected_reasons: groupRejectionReasons((rejectedReasons ?? []) as Array<{ auto_rejected_reason: string | null }>),
    human_edits: ((edited ?? []) as Array<{ body_original: string | null; body_edited: string | null }>).map((e) => ({
      before: (e.body_original ?? "").slice(0, 900),
      after: (e.body_edited ?? "").slice(0, 900),
    })),
    gate_failures: Object.fromEntries(gateCodes),
    reviewer_issues: criticIssues.slice(0, 30),
    writing_variants: ((arms ?? []) as ArmRow[])
      .filter((a) => a.learner.startsWith("writer."))
      .map((a) => ({ learner: a.learner, key: a.key, status: a.status, trials: a.trials, mean_reward: Number(meanReward(toArm(a)).toFixed(3)), text: a.config?.text ?? a.config?.description ?? null })),
  };

  const { data: attempt, error: attemptError } = await db
    .from("learning_insights")
    .insert({
      tenant_id: tenantId,
      learner: REVIEW_ATTEMPT_LEARNER,
      kind: "observation",
      title: "Weekly AI review: attempt started",
      detail: null,
      evidence: {},
      applied: true,
    })
    .select("id")
    .single();
  // No mark, no paid call: an unmarked failure is what retried every tick.
  if (attemptError || !attempt) return { ran: false, reason: "could not record the review attempt; skipped", guidance: [] };
  const markAttempt = async (title: string, detail: string | null, evidence: Record<string, unknown>) => {
    await db.from("learning_insights").update({ title, detail, evidence }).eq("id", (attempt as { id: string }).id);
  };

  const call = await deps.call({
    model: ANTHROPIC_DEFAULT_MODEL,
    system: REVIEW_SYSTEM,
    user: `This week's evidence:\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\``,
    // The prompt allows ~6k characters of output; 1500 tokens could truncate it.
    max_tokens: 2500,
    timeoutMs: 45_000,
    schema: reviewSchema,
  });
  if (call.usage) {
    await deps.record({
      tenantId,
      model: ANTHROPIC_DEFAULT_MODEL,
      entity_type: "pitch",
      entity_id: null,
      usage: call.usage,
      metadata: { kind: "learning_review" },
    });
  }
  const nextTry = new Date(now.getTime() + DAY).toISOString().slice(0, 16).replace("T", " ");
  if (!call.ok) {
    const why = reviewFailureText(call.error);
    await markAttempt(`Weekly AI review failed (${call.reason}); next try after ${nextTry} UTC`, why, { reason: call.reason });
    return { ran: false, reason: `review call failed (${call.reason}): ${why}`, guidance: [] };
  }
  const { dropped } = call.data;
  if (dropped > 0 && call.data.observations.length === 0 && call.data.guidance.length === 0) {
    const why = `every item the model returned was malformed (${dropped} dropped)`;
    await markAttempt(`Weekly AI review failed (parse); next try after ${nextTry} UTC`, why, { reason: "parse", dropped });
    return { ran: false, reason: `review call failed (parse): ${why}`, guidance: [] };
  }
  await markAttempt(`Weekly AI review ran${dropped ? ` (${dropped} malformed item${dropped === 1 ? "" : "s"} dropped)` : ""}`, null, { dropped });

  for (const o of call.data.observations ?? []) {
    await insight(db, tenantId, { learner: "review", kind: "observation", title: o.title, detail: o.evidence });
  }
  const created: string[] = [];
  const stamp = now.toISOString().slice(0, 10);
  // Too many live experiments spread the traffic too thin to learn anything.
  const activeGuidance = ((arms ?? []) as ArmRow[]).filter((a) => a.learner === "writer.guidance" && a.status === "challenger").length;
  const room = Math.max(0, MAX_GUIDANCE_CHALLENGERS - activeGuidance);
  for (const [i, g] of (call.data.guidance ?? []).slice(0, room).entries()) {
    const clean = sanitizeGuidance(g.text);
    if (!clean.ok) {
      await insight(db, tenantId, { learner: "review", kind: "proposal", title: `Discarded guidance: ${g.text.slice(0, 120)}`, detail: clean.reason });
      continue;
    }
    const key = `g-${stamp}-${i + 1}`;
    const { error } = await db.from("learning_arms").insert({
      tenant_id: tenantId,
      learner: "writer.guidance",
      key,
      status: "challenger",
      origin: "learner",
      config: { text: clean.text, why: g.why },
    });
    if (error) continue;
    created.push(clean.text);
    await insight(db, tenantId, {
      learner: "review",
      kind: "challenger",
      title: `Testing new guidance: ${clean.text}`,
      detail: g.why,
    });
  }
  if (created.length === 0) await insight(db, tenantId, { learner: "review", kind: "observation", title: "Weekly review: no new guidance this week" });
  return { ran: true, reason: "ok", guidance: created };
}
