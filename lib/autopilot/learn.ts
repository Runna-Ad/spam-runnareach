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
 *   weeklyReview       once a week: an AI review of the week's replies, holds,
 *                      edits, gate failures and arm results proposes up to two
 *                      new writing instructions; each that passes the guidance
 *                      safety check enters live testing as a challenger arm.
 *
 * What learning may never touch (audit §6.4): the gate, compliance, caps,
 * breakers, do-not-contact, the no-invented-numbers rule. Guidance can only add
 * to the writer's rules, and every email still passes the gate and reviewer.
 */

import { z } from "zod";
import { ANTHROPIC_DEFAULT_MODEL, claudeIsAvailable, structuredCall } from "@/lib/anthropic/client";
import { isUnderDailyCap, recordClaudeCall } from "@/lib/anthropic/cost-tracking";
import { chooseArm, meanReward, reviewArms, type Arm, type ArmAction } from "@/lib/learning/bandit";
import { armStats, funnelForProspect, sanitizeGuidance, type PitchOutcomeInput } from "@/lib/learning/outcomes";
import { hunterDemand, industryScore, proposeCells, type IcpForCells, type IndustryEvidence } from "@/lib/learning/icp";
import type { OutcomeEvent } from "@/lib/learning/reward";
import { cellArm, cellKey, prospectReward, type ProspectFunnel } from "@/lib/learning/scout";
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
    await settleLearner(db, tenantId, learner, armStats(inputs, learner, now), 30);
  }

  // Scout cells: autopilot discovery jobs and what their prospects became.
  const { data: jobs } = await db
    .from("discovery_jobs")
    .select("id, status, stats, prospect_ids, created_at")
    .eq("tenant_id", tenantId)
    .not("stats->focus", "is", null)
    .gte("created_at", since)
    .order("created_at", { ascending: true });
  const jobRows = (jobs ?? []) as Array<{ id: string; status: string; stats: { focus?: { cell_key: string }; new?: number }; prospect_ids: string[] | null }>;
  if (jobRows.length === 0) return;

  const prospectIds = [...new Set(jobRows.flatMap((j) => j.prospect_ids ?? []))];
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

  const funnels = new Map<string, ProspectFunnel[]>();
  const emptyRuns = new Map<string, number>();
  for (const job of jobRows) {
    const key = job.stats.focus?.cell_key;
    if (!key) continue;
    if (job.status === "done") emptyRuns.set(key, (job.stats.new ?? 0) === 0 ? (emptyRuns.get(key) ?? 0) + 1 : 0);
    const list = funnels.get(key) ?? [];
    for (const pid of job.prospect_ids ?? []) {
      const ps = (pitchesByProspect.get(pid) ?? []).map((p) => ({ ...p, events: scoutEvents.get(p.id) ?? [] }));
      list.push(funnelForProspect(statusById.get(pid) ?? "raw", ps, now));
    }
    funnels.set(key, list);
  }
  const totals = new Map<string, { reward: number; trials: number; negatives: number }>();
  for (const [key, list] of funnels) {
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
    .select("prospect_ids")
    .eq("tenant_id", tenantId)
    .gte("created_at", since);
  const prospectIds = [...new Set(((jobs ?? []) as Array<{ prospect_ids: string[] | null }>).flatMap((j) => j.prospect_ids ?? []))];

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

const reviewSchema = z.object({
  observations: z
    .array(z.object({ title: z.string().min(5).max(200), evidence: z.string().min(5).max(600) }))
    .max(6)
    .default([]),
  guidance: z
    .array(z.object({ text: z.string().min(12).max(400), why: z.string().min(5).max(400) }))
    .max(2)
    .default([]),
});

const REVIEW_SYSTEM = `You improve an automated cold-email writer for Rünna (Runna Advertising), a Mexico/Canada agency that helps small and mid-size businesses with marketing and automation. Emails link to a free audit tool (the Inefficiency Hunter).

Each week you read what happened: replies (with intent), emails a person held back or rejected and why, how people edited drafts, which checks failed, and how the current writing variants performed. You return:
- observations: what the evidence shows, each with the specific evidence ("4 of 6 replies asked what the audit costs").
- guidance: at most 2 NEW one-sentence writing instructions worth testing on live emails, each tied to the evidence. They will be A/B tested against the current writer, so only propose what the evidence suggests could beat it.

Hard limits (an instruction that breaks one is discarded):
- no numbers or statistics of any kind; never suggest claiming results;
- never relax or contradict the writer's rules (no client names, no invented facts, plain words, short emails, one link to the free audit);
- plain language, no marketing jargon;
- an instruction about HOW to write, not about a specific prospect.
If the evidence is too thin to support a new instruction, return an empty guidance list.`;

/** At most once a week, and only with something to learn from. Returns what was created. */
export async function weeklyReview(db: Db, tenantId: string, now: Date = new Date()): Promise<{ ran: boolean; reason: string; guidance: string[] }> {
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const { count: recent } = await db
    .from("learning_insights")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("learner", "review")
    .gte("created_at", weekAgo);
  if ((recent ?? 0) > 0) return { ran: false, reason: "reviewed this week", guidance: [] };

  const since = new Date(now.getTime() - 14 * DAY).toISOString();
  const { count: sent } = await db
    .from("pitches")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .is("parent_pitch_id", null)
    .gte("sent_at", since);
  if ((sent ?? 0) < 10) return { ran: false, reason: `only ${sent ?? 0} emails sent in 14 days`, guidance: [] };
  if (!claudeIsAvailable()) return { ran: false, reason: "Claude unavailable", guidance: [] };
  const cap = await isUnderDailyCap(tenantId);
  if (!cap.under) return { ran: false, reason: "daily AI cap reached", guidance: [] };

  const [{ data: replies }, { data: held }, { data: edited }, { data: drafts }, { data: arms }] = await Promise.all([
    db.from("replies").select("intent, body_text").eq("tenant_id", tenantId).gte("received_at", since).limit(40),
    db.from("pitches").select("subject, rejection_reason, autopilot_reasons, status").eq("tenant_id", tenantId).in("status", ["reviewer_rejected"]).gte("updated_at", since).limit(20),
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

  const call = await structuredCall({
    model: ANTHROPIC_DEFAULT_MODEL,
    system: REVIEW_SYSTEM,
    user: `This week's evidence:\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\``,
    max_tokens: 1500,
    timeoutMs: 45_000,
    schema: reviewSchema,
  });
  if (call.usage) {
    await recordClaudeCall({
      tenantId,
      model: ANTHROPIC_DEFAULT_MODEL,
      entity_type: "pitch",
      entity_id: null,
      usage: call.usage,
      metadata: { kind: "learning_review" },
    });
  }
  if (!call.ok) return { ran: false, reason: "review call failed", guidance: [] };

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
