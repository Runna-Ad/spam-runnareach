/**
 * The Monday weekly report: what the platform did in the last 7 days, against
 * the 7 before, and how healthy it is. Plain text, no AI, read in a minute.
 *
 * Pure: snapshot.ts gathers the rows, this file counts and formats them, so
 * tests/reports-weekly.test.ts runs it over a fixture. Rules:
 *   - Test addresses (lib/compliance/test-addresses.ts, pitch_events.payload.test)
 *     are dropped from every count here, not in the queries.
 *   - A source whose query failed is null and prints "n/a", never 0.
 *   - Arm rates only from 20 trials up (lib/learning/report.ts); else "too early".
 */

import { isTestAddress } from "../compliance/test-addresses.ts";
import { summarizeArms, type ArmRow } from "../learning/report.ts";

const DAY = 86_400_000;

/** null = the query failed or the source doesn't exist: printed as "n/a". */
type Rows<T> = T[] | null;

export type WeeklyRaw = {
  /** ISO time the report covers up to; the windows are the 7 and 14 days before. */
  now: string;
  appUrl: string;
  /** Sent pitches since 14 days ago. followUp = has a parent pitch. */
  sent: Rows<{ at: string; followUp: boolean; email: string | null }>;
  replies: Rows<{ at: string; intent: string; email: string | null }>;
  /** Opportunities created or closed in the last 14 days. */
  opportunities: Rows<{ createdAt: string; stage: string; closedAt: string | null; valueCad: number | null; email: string | null }>;
  optOuts: Rows<{ at: string; email: string | null }>;
  bounces: Rows<{ at: string; email: string | null; test: boolean }>;
  discoveryJobs: Rows<{ at: string }>;
  researched: Rows<{ at: string }>;
  /** First-touch pitches created (drafts), with how the autopilot treated them. */
  drafts: Rows<{ at: string; email: string | null; autoRejected: boolean; reason: string | null }>;
  /** Autopilot approvals (AUTO scheduled), with the pitch's status now. */
  autoScheduled: Rows<{ at: string; status: string; email: string | null }>;
  autopilot: { enabled: boolean; stage: string; reason: string | null } | null;
  breakerTrips: Rows<{ at: string; title: string }>;
  arms: Rows<ArmRow>;
  /** learning_insights of the last 7 days, breaker rows excluded (counted above). */
  insights: Rows<{ at: string; kind: string; title: string }>;
  aiSpend: Rows<{ at: string; usd: number }>;
  dailyCapUsd: number;
  /** Warmup sends of the last 7 days; landed = null until checked. */
  warmup: Rows<{ at: string; landed: boolean | null }>;
  /** health.alert audit rows of the last 7 days. */
  alerts: Rows<{ at: string; kind: string }>;
};

type Pair = { thisWeek: number; lastWeek: number } | null;

export type WeeklyStats = {
  from: string;
  to: string;
  firstEmails: Pair;
  followUps: Pair;
  replies: Pair;
  repliesByIntent: Array<[string, number]> | null;
  meetings: Pair;
  won: { count: number; valueCad: number | null } | null;
  lost: { count: number; valueCad: number | null } | null;
  optOuts: Pair;
  bounces: Pair;
  discoveryJobs: Pair;
  researched: Pair;
  drafts: Pair;
  autoScheduled: Pair;
  vetoed: number | null;
  autoRejected: { count: number; topReasons: Array<[string, number]> } | null;
  autopilot: WeeklyRaw["autopilot"];
  breakerTrips: number | null;
  topArms: Array<{ learner: string; key: string; trials: number; rate: number | null; confidence: string }> | null;
  insights: { count: number; byKind: Array<[string, number]>; titles: string[] } | null;
  aiSpendUsd: number | null;
  aiCapUsd: number;
  placement: { inbox: number; checked: number } | null;
  alerts: { count: number; kinds: string[] } | null;
};

const realEmail = (email: string | null | undefined) => !isTestAddress(email);

function windowOf(at: string, now: number): "this" | "last" | null {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t) || t > now) return null;
  if (t > now - 7 * DAY) return "this";
  if (t > now - 14 * DAY) return "last";
  return null;
}

function pair<T>(rows: Rows<T>, at: (r: T) => string, now: number, keep: (r: T) => boolean = () => true): Pair {
  if (!rows) return null;
  const out = { thisWeek: 0, lastWeek: 0 };
  for (const r of rows) {
    if (!keep(r)) continue;
    const w = windowOf(at(r), now);
    if (w === "this") out.thisWeek++;
    else if (w === "last") out.lastWeek++;
  }
  return out;
}

function thisWeek<T>(rows: T[], at: (r: T) => string, now: number): T[] {
  return rows.filter((r) => windowOf(at(r), now) === "this");
}

function tally(values: string[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function closed(rows: NonNullable<WeeklyRaw["opportunities"]>, stage: "won" | "lost", now: number) {
  const hit = rows.filter((o) => o.stage === stage && o.closedAt && windowOf(o.closedAt, now) === "this");
  const values = hit.map((o) => o.valueCad).filter((v): v is number => typeof v === "number");
  return { count: hit.length, valueCad: values.length ? values.reduce((a, b) => a + b, 0) : null };
}

export function buildWeeklyStats(raw: WeeklyRaw): WeeklyStats {
  const now = new Date(raw.now).getTime();
  const sent = raw.sent?.filter((r) => realEmail(r.email)) ?? null;
  const replies = raw.replies?.filter((r) => realEmail(r.email) && r.intent !== "bounced") ?? null;
  const opps = raw.opportunities?.filter((o) => realEmail(o.email)) ?? null;
  const drafts = raw.drafts?.filter((d) => realEmail(d.email)) ?? null;
  const autos = raw.autoScheduled?.filter((a) => realEmail(a.email)) ?? null;

  const rejectedThisWeek = drafts ? thisWeek(drafts, (d) => d.at, now).filter((d) => d.autoRejected) : null;
  const armGroups = raw.arms ? summarizeArms(raw.arms) : null;
  const insightsThisWeek = raw.insights ? thisWeek(raw.insights, (i) => i.at, now) : null;
  const checks = raw.warmup ? thisWeek(raw.warmup, (w) => w.at, now).filter((w) => w.landed !== null) : null;
  const alerts = raw.alerts ? thisWeek(raw.alerts, (a) => a.at, now) : null;

  return {
    from: new Date(now - 7 * DAY).toISOString(),
    to: raw.now,
    firstEmails: pair(sent, (r) => r.at, now, (r) => !r.followUp),
    followUps: pair(sent, (r) => r.at, now, (r) => r.followUp),
    replies: pair(replies, (r) => r.at, now),
    repliesByIntent: replies ? tally(thisWeek(replies, (r) => r.at, now).map((r) => r.intent)) : null,
    meetings: pair(opps, (o) => o.createdAt, now),
    won: opps ? closed(opps, "won", now) : null,
    lost: opps ? closed(opps, "lost", now) : null,
    optOuts: pair(raw.optOuts, (r) => r.at, now, (r) => realEmail(r.email)),
    bounces: pair(raw.bounces, (r) => r.at, now, (r) => !r.test && realEmail(r.email)),
    discoveryJobs: pair(raw.discoveryJobs, (r) => r.at, now),
    researched: pair(raw.researched, (r) => r.at, now),
    drafts: pair(drafts, (d) => d.at, now),
    autoScheduled: pair(autos, (a) => a.at, now),
    // Same predicate as the governor's autoVetoed (lib/autopilot/tick.ts evaluateStage):
    // approved by the autopilot, then moved back to draft or rejected by a person.
    vetoed: autos ? thisWeek(autos, (a) => a.at, now).filter((a) => a.status === "draft" || a.status === "reviewer_rejected").length : null,
    autoRejected: rejectedThisWeek
      ? { count: rejectedThisWeek.length, topReasons: tally(rejectedThisWeek.map((d) => reasonLabel(d.reason))).slice(0, 3) }
      : null,
    autopilot: raw.autopilot,
    breakerTrips: raw.breakerTrips ? thisWeek(raw.breakerTrips, (b) => b.at, now).length : null,
    topArms: armGroups
      ? armGroups
          .flatMap((g) => g.active)
          .sort((a, b) => b.trials - a.trials || a.key.localeCompare(b.key))
          .slice(0, 5)
          .map((a) => ({ learner: a.learner, key: a.key, trials: a.trials, rate: a.rate, confidence: a.confidence }))
      : null,
    insights: insightsThisWeek
      ? {
          count: insightsThisWeek.length,
          byKind: tally(insightsThisWeek.map((i) => i.kind)),
          titles: insightsThisWeek.slice(0, 3).map((i) => i.title),
        }
      : null,
    aiSpendUsd: raw.aiSpend ? thisWeek(raw.aiSpend, (c) => c.at, now).reduce((s, c) => s + c.usd, 0) : null,
    aiCapUsd: raw.dailyCapUsd * 7,
    placement: checks && checks.length > 0 ? { inbox: checks.filter((c) => c.landed === true).length, checked: checks.length } : null,
    alerts: alerts ? { count: alerts.length, kinds: [...new Set(alerts.map((a) => a.kind))].sort() } : null,
  };
}

/** Group reasons by their first clause so "x: detail A" and "x: detail B" count together. */
function reasonLabel(reason: string | null): string {
  if (!reason) return "no reason recorded";
  const head = reason.split(/[:;\n]/)[0]?.trim() ?? "";
  return (head || reason).slice(0, 80);
}

const n = (p: Pair, which: "thisWeek" | "lastWeek") => (p ? String(p[which]) : "n/a");
const vs = (label: string, p: Pair) => `${label}: ${n(p, "thisWeek")} (last week ${n(p, "lastWeek")})`;
const usd = (v: number) => `$${v.toFixed(2)}`;
const cad = (v: number | null) => (v === null ? "value n/a" : `CAD ${Math.round(v).toLocaleString("en-US")}`);
const day = (iso: string) => iso.slice(0, 10);

export function formatWeeklyReport(s: WeeklyStats, appUrl: string): { subject: string; body: string } {
  const lines: string[] = [];
  lines.push(`S.P.A.M. weekly report, ${day(s.from)} to ${day(s.to)} (last 7 days vs the 7 before).`);
  lines.push("Test addresses are excluded. n/a = no data.");
  lines.push("");
  lines.push("OUTREACH");
  lines.push(vs("First emails sent", s.firstEmails));
  lines.push(vs("Follow-ups sent", s.followUps));
  lines.push(vs("Replies", s.replies));
  if (s.repliesByIntent && s.repliesByIntent.length > 0) {
    lines.push(`  by intent: ${s.repliesByIntent.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  lines.push(vs("Meetings booked", s.meetings));
  lines.push(`Won: ${s.won ? `${s.won.count} (${cad(s.won.valueCad)})` : "n/a"}`);
  lines.push(`Lost: ${s.lost ? `${s.lost.count} (${cad(s.lost.valueCad)})` : "n/a"}`);
  lines.push(vs("Opt-outs", s.optOuts));
  lines.push(vs("Bounces", s.bounces));
  lines.push("");
  lines.push("PIPELINE");
  lines.push(vs("Discovery jobs", s.discoveryJobs));
  lines.push(vs("Prospects researched", s.researched));
  lines.push(vs("Drafts written", s.drafts));
  lines.push(vs("AUTO scheduled", s.autoScheduled));
  lines.push(`Held by a person (vetoes): ${s.vetoed ?? "n/a"}`);
  lines.push(`Auto-rejected: ${s.autoRejected ? s.autoRejected.count : "n/a"}`);
  for (const [reason, count] of s.autoRejected?.topReasons ?? []) lines.push(`  ${count} × ${reason}`);
  lines.push("");
  lines.push("AUTOPILOT");
  lines.push(
    s.autopilot
      ? `Stage: ${s.autopilot.stage}${s.autopilot.enabled ? "" : " (kill switch OFF)"}${s.autopilot.reason ? `. ${s.autopilot.reason}` : ""}`
      : "Stage: n/a",
  );
  lines.push(`Breaker trips this week: ${s.breakerTrips ?? "n/a"}`);
  lines.push("");
  lines.push("LEARNING");
  if (!s.topArms) lines.push("Top arms: n/a");
  else if (s.topArms.length === 0) lines.push("Top arms: none yet");
  else {
    lines.push("Top arms by trials:");
    for (const a of s.topArms) {
      const rate = a.rate === null ? "too early" : `${(a.rate * 100).toFixed(1)}% reward rate (${a.confidence})`;
      lines.push(`  ${a.learner} / ${a.key}: ${a.trials} trials, ${rate}`);
    }
  }
  if (!s.insights) lines.push("Insights this week: n/a");
  else {
    const kinds = s.insights.byKind.map(([k, v]) => `${k} ${v}`).join(", ");
    lines.push(`Insights this week: ${s.insights.count}${kinds ? ` (${kinds})` : ""}`);
    for (const t of s.insights.titles) lines.push(`  - ${t.slice(0, 120)}`);
  }
  lines.push("");
  lines.push("HEALTH");
  lines.push(`AI spend: ${s.aiSpendUsd === null ? "n/a" : usd(s.aiSpendUsd)} of ${usd(s.aiCapUsd)} weekly cap (7 × daily cap)`);
  lines.push(
    `Warmup inbox placement: ${
      s.placement ? `${Math.round((s.placement.inbox / s.placement.checked) * 100)}% inbox (${s.placement.inbox}/${s.placement.checked} checked)` : "n/a (not measured this week)"
    }`,
  );
  lines.push(
    `Emergencies raised: ${s.alerts ? `${s.alerts.count}${s.alerts.kinds.length ? ` (${s.alerts.kinds.join(", ")})` : ""}` : "n/a"}`,
  );
  lines.push("");
  lines.push(`${appUrl}/analytics`);

  const parts = [
    s.firstEmails ? `${s.firstEmails.thisWeek} sent` : null,
    s.replies ? `${s.replies.thisWeek} replies` : null,
    s.meetings ? `${s.meetings.thisWeek} meetings` : null,
  ].filter(Boolean);
  return { subject: `S.P.A.M. weekly: ${parts.length ? parts.join(", ") : "report"}`, body: lines.join("\n") };
}

// ── Route orchestration (deps injected so tests run it in memory) ──────────────

export type WeeklyRouteDeps = {
  authorize: (req: Request) => Promise<boolean>;
  tenantIds: () => Promise<string[]>;
  gather: (tenantId: string, now: Date) => Promise<WeeklyRaw>;
  send: (tenantId: string, message: { subject: string; body: string }) => Promise<{ sent: number; failed: string[] }>;
  now?: () => Date;
};

export async function handleWeeklyReport(req: Request, deps: WeeklyRouteDeps): Promise<Response> {
  if (!(await deps.authorize(req))) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const now = deps.now?.() ?? new Date();
  let tenants: string[];
  try {
    tenants = await deps.tenantIds();
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
  let sent = 0;
  const failed: string[] = [];
  const reports: Array<{ tenantId: string; subject: string; body?: string }> = [];
  for (const tenantId of tenants) {
    try {
      const raw = await deps.gather(tenantId, now);
      const message = formatWeeklyReport(buildWeeklyStats(raw), raw.appUrl);
      if (dry) {
        reports.push({ tenantId, ...message });
        continue;
      }
      const res = await deps.send(tenantId, message);
      sent += res.sent;
      failed.push(...res.failed.map((f) => `${tenantId}: ${f}`));
      reports.push({ tenantId, subject: message.subject });
    } catch (err) {
      failed.push(`${tenantId}: ${(err as Error).message}`);
    }
  }
  return Response.json({ ok: true, dry, sent, failed, reports });
}
