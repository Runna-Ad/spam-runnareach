/**
 * The Monday weekly report: what the platform did in the last 7 days, against
 * the 7 before, and how healthy it is. No AI, read in a minute: a plain-text
 * part (formatWeeklyReport) and a designed HTML part with the same numbers
 * (formatWeeklyReportHtml).
 *
 * Pure: snapshot.ts gathers the rows, this file counts and formats them, so
 * tests/reports-weekly.test.ts runs it over a fixture. Rules:
 *   - Test addresses (lib/compliance/test-addresses.ts, pitch_events.payload.test)
 *     are dropped from every count here, not in the queries.
 *   - A source whose query failed is null and prints "n/a", never 0.
 *   - Arm rates only from 20 trials up (lib/learning/report.ts); else "too early".
 */

import { vetoedByPerson } from "../autopilot/governor.ts";
import { isTestAddress } from "../compliance/test-addresses.ts";
import { summarizeArms, type ArmRow } from "../learning/report.ts";
import type { OutcomeEvent } from "../learning/reward.ts";
import { candidateFromRow, onDnc, type CandidateRow, type DncEntries } from "../pitches/exemplar-queries.ts";
import { qualifiesAsExemplar } from "../pitches/exemplars.ts";

const DAY = 86_400_000;

/** null = the query failed or the source doesn't exist: printed as "n/a". */
type Rows<T> = T[] | null;

/**
 * Every settled root send of the tenant as fetchExemplars reads it
 * (EXEMPLAR_CANDIDATE_COLUMNS), with its outcome events, and the
 * do-not-contact entries for their addresses and domains.
 */
export type ExemplarPool = {
  pitches: Array<CandidateRow & { events: OutcomeEvent[] }>;
  dnc: DncEntries;
};

export type ExemplarReadiness = {
  count: number;
  /** "EN" / "ES" → pitches, biggest first. */
  byLang: Array<[string, number]>;
  /** "legal/ca" etc. → pitches, the three biggest. */
  topSegments: Array<[string, number]>;
};

/** From this many qualifying pitches, the report suggests turning EXEMPLARS_ENABLED on. */
export const EXEMPLARS_WORTH_IT = 5;

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
  /**
   * Autopilot approvals (AUTO scheduled), with the pitch's status and
   * autopilot_reasons now (reasons tell a person's hold from the autopilot's
   * own pull-back; absent = read as a person's).
   */
  autoScheduled: Rows<{ at: string; status: string; email: string | null; reasons?: string[] | null }>;
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
  /** The exemplar kill switch (lib/pitches/exemplar-queries.ts exemplarsEnabled). */
  exemplarsEnabled: boolean;
  /** null when any of its reads failed: printed as "n/a". */
  exemplarPool: ExemplarPool | null;
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
  exemplars: { enabled: boolean; qualifying: ExemplarReadiness | null };
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
    // Approved by the autopilot, then sent back by a person: the same predicate
    // as the stage's veto count (governor vetoedByPerson). A pull-back by the
    // autopilot itself (stage drop or kill switch) is not a person's veto.
    vetoed: autos ? thisWeek(autos, (a) => a.at, now).filter((a) => vetoedByPerson({ status: a.status, autopilot_reasons: a.reasons })).length : null,
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
    exemplars: { enabled: raw.exemplarsEnabled, qualifying: raw.exemplarPool ? exemplarReadiness(raw.exemplarPool, new Date(now)) : null },
  };
}

/**
 * How many past pitches fetchExemplars could pick for some target today, each
 * counted once: its row mapping (a suppressed prospect is skipped), the shared
 * qualifiesAsExemplar (everything but the target match), and the
 * do-not-contact list.
 */
export function exemplarReadiness(pool: ExemplarPool, now: Date): ExemplarReadiness {
  const seen = new Set<string>();
  const langs: string[] = [];
  const segments: string[] = [];
  for (const row of pool.pitches) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const c = candidateFromRow(row);
    if (!c) continue;
    const q = qualifiesAsExemplar({ ...c, events: row.events }, { now, isTestAddress });
    if (!q || onDnc(pool.dnc, c.recipient_email)) continue;
    langs.push(c.lang.toUpperCase());
    segments.push(`${q.segment.industry}/${q.segment.market}`);
  }
  return { count: langs.length, byLang: tally(langs), topSegments: tally(segments).slice(0, 3) };
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

/** "Exemplars: off (EXEMPLARS_ENABLED unset). Past pitches that qualify: 3 (EN 2, ES 1; top: legal/ca 2, dental/mx 1)". */
function exemplarsLine(e: WeeklyStats["exemplars"]): string {
  const head = e.enabled ? "Exemplars: on." : "Exemplars: off (EXEMPLARS_ENABLED unset).";
  return `${head} Past pitches that qualify: ${exemplarsCount(e)}`;
}

/** Off, and enough qualify that switching on would show examples. */
function worthTurningOn(e: WeeklyStats["exemplars"]): boolean {
  return !e.enabled && (e.qualifying?.count ?? 0) >= EXEMPLARS_WORTH_IT;
}

const exemplarLangs = (q: ExemplarReadiness) => q.byLang.map(([k, v]) => `${k} ${v}`).join(", ");
const exemplarTop = (q: ExemplarReadiness) => q.topSegments.map(([k, v]) => `${k} ${v}`).join(", ");

/** The count with its breakdown, and the hint when it is worth switching on. */
function exemplarsCount(e: WeeklyStats["exemplars"]): string {
  const q = e.qualifying;
  if (!q) return "n/a";
  if (q.count === 0) return "0";
  return `${q.count} (${exemplarLangs(q)}; top: ${exemplarTop(q)})${worthTurningOn(e) ? ": worth turning on" : ""}`;
}

/** "2 sent, 2 replies, 1 meeting": the subject line and the HTML header. null when all three are n/a. */
function summaryOf(s: WeeklyStats): string | null {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts = [
    s.firstEmails ? `${s.firstEmails.thisWeek} sent` : null,
    s.replies ? n(s.replies.thisWeek, "reply", "replies") : null,
    s.meetings ? n(s.meetings.thisWeek, "meeting", "meetings") : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

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
  lines.push(exemplarsLine(s.exemplars));
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

  return { subject: `S.P.A.M. weekly: ${summaryOf(s) ?? "report"}`, body: lines.join("\n") };
}

// ── The designed HTML part ────────────────────────────────────────────────────
//
// The same numbers as formatWeeklyReport, laid out to scan in a minute. Email-
// safe only: role="presentation" tables, inline styles, max 600px, the system
// font stack, no images, no <style>, no external CSS, fonts or JS, and no URL
// but appUrl. Light backgrounds and no dark fills, so Gmail's dark mode can
// invert it cleanly. Every interpolated string goes through esc().

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const COLOR = {
  page: "#ffffff",
  card: "#f8fafc",
  border: "#e2e8f0",
  text: "#0f172a",
  secondary: "#475569",
  muted: "#94a3b8",
  good: "#15803d",
  bad: "#b91c1c",
  neutral: "#64748b",
  button: "#1d4ed8",
} as const;

/** Which way is good: up for sent/replies/meetings…, down for opt-outs/bounces…, neither for the rest. */
type Tone = "upGood" | "upBad" | "neutral";

const esc = (v: string | number) =>
  String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const span = (text: string | number, color: string, extra = "") => `<span style="color:${color};${extra}">${esc(text)}</span>`;
const NA = span("n/a", COLOR.muted);

/** ▲2 / ▼1 / — against last week, coloured by what is good for this metric. */
function deltaHtml(p: Pair, tone: Tone): string {
  if (!p) return "";
  const d = p.thisWeek - p.lastWeek;
  if (d === 0) return span("—", COLOR.neutral, "font-size:12px;font-weight:600;");
  const color = tone === "neutral" ? COLOR.neutral : (d > 0) === (tone === "upGood") ? COLOR.good : COLOR.bad;
  return span(`${d > 0 ? "▲" : "▼"}${Math.abs(d)}`, color, "font-size:12px;font-weight:600;");
}

/** A count with no last-week number (won, auto-rejected, breaker trips, emergencies): coloured when it is not 0. */
function countColor(count: number, tone: Tone): string {
  if (count === 0 || tone === "neutral") return COLOR.text;
  return tone === "upGood" ? COLOR.good : COLOR.bad;
}

const CELL = `font-family:${FONT};font-size:14px;line-height:20px;padding:6px 0;border-top:1px solid ${COLOR.border};`;

/** label | this week (+ delta) | last week. */
function pairRow(label: string, p: Pair, tone: Tone): string {
  const thisWeek = p ? `${span(p.thisWeek, COLOR.text, "font-weight:600;")}&nbsp;${deltaHtml(p, tone)}` : NA;
  const lastWeek = p ? span(p.lastWeek, COLOR.secondary) : NA;
  return (
    `<tr><td style="${CELL}color:${COLOR.text};">${esc(label)}</td>` +
    `<td align="right" style="${CELL}white-space:nowrap;">${thisWeek}</td>` +
    `<td align="right" style="${CELL}white-space:nowrap;width:80px;">${lastWeek}</td></tr>`
  );
}

/** label | a value over both columns (already-escaped HTML). */
function valueRow(label: string, valueHtml: string): string {
  return (
    `<tr><td style="${CELL}color:${COLOR.text};">${esc(label)}</td>` +
    `<td colspan="2" align="right" style="${CELL}">${valueHtml}</td></tr>`
  );
}

/** A secondary line under a row: intents, reasons, arms, titles, breakdowns. */
function detailRow(text: string): string {
  return `<tr><td colspan="3" style="font-family:${FONT};font-size:12px;line-height:18px;padding:0 0 6px 12px;color:${COLOR.secondary};">${esc(text)}</td></tr>`;
}

/** A count, then restHtml (already escaped) after it; n/a when the count is unknown. */
const countValue = (count: number | null, tone: Tone, restHtml = "") =>
  count === null ? NA : `${span(count, countColor(count, tone), "font-weight:600;")}${restHtml}`;
const aside = (text: string) => (text ? span(text, COLOR.secondary) : "");
/** " (CAD 4,500)", or a muted " (value n/a)". */
const cadAside = (v: number | null) => (v === null ? span(" (value n/a)", COLOR.muted) : aside(` (${cad(v)})`));

function card(title: string, rows: string[], withColumns: boolean): string {
  const head = withColumns
    ? `<tr><td style="font-family:${FONT};font-size:11px;color:${COLOR.secondary};padding:0 0 4px;"></td>` +
      `<td align="right" style="font-family:${FONT};font-size:11px;color:${COLOR.secondary};padding:0 0 4px;white-space:nowrap;">This week</td>` +
      `<td align="right" style="font-family:${FONT};font-size:11px;color:${COLOR.secondary};padding:0 0 4px;white-space:nowrap;width:80px;">Last week</td></tr>`
    : "";
  return (
    `<tr><td style="padding:0 0 16px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLOR.card}" style="background-color:${COLOR.card};border:1px solid ${COLOR.border};border-radius:8px;">` +
    `<tr><td style="padding:14px 16px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
    `<tr><td colspan="3" style="font-family:${FONT};font-size:13px;font-weight:700;letter-spacing:0.04em;color:${COLOR.text};padding:0 0 8px;">${esc(title)}</td></tr>` +
    head +
    rows.join("") +
    `</table></td></tr></table></td></tr>`
  );
}

function tile(label: string, p: Pair): string {
  const big = p ? span(p.thisWeek, COLOR.text) : NA;
  const last = `last week ${p ? esc(p.lastWeek) : NA}`;
  return (
    `<td width="33%" valign="top" bgcolor="${COLOR.card}" style="background-color:${COLOR.card};border:1px solid ${COLOR.border};border-radius:8px;padding:12px 14px;">` +
    `<div style="font-family:${FONT};font-size:12px;color:${COLOR.secondary};">${esc(label)}</div>` +
    `<div style="font-family:${FONT};font-size:28px;line-height:34px;font-weight:700;padding:4px 0 2px;">${big}</div>` +
    `<div style="font-family:${FONT};font-size:12px;color:${COLOR.secondary};">${last}&nbsp;&nbsp;${deltaHtml(p, "upGood")}</div>` +
    `</td>`
  );
}

export function formatWeeklyReportHtml(s: WeeklyStats, appUrl: string): string {
  const outreach = [
    pairRow("First emails sent", s.firstEmails, "upGood"),
    pairRow("Follow-ups sent", s.followUps, "neutral"),
    pairRow("Replies", s.replies, "upGood"),
    ...(s.repliesByIntent && s.repliesByIntent.length > 0 ? [detailRow(`by intent: ${s.repliesByIntent.map(([k, v]) => `${k} ${v}`).join(", ")}`)] : []),
    pairRow("Meetings booked", s.meetings, "upGood"),
    valueRow("Won", s.won ? countValue(s.won.count, "upGood", cadAside(s.won.valueCad)) : NA),
    valueRow("Lost", s.lost ? countValue(s.lost.count, "neutral", cadAside(s.lost.valueCad)) : NA),
    pairRow("Opt-outs", s.optOuts, "upBad"),
    pairRow("Bounces", s.bounces, "upBad"),
  ];
  const pipeline = [
    pairRow("Discovery jobs", s.discoveryJobs, "neutral"),
    pairRow("Prospects researched", s.researched, "upGood"),
    pairRow("Drafts written", s.drafts, "upGood"),
    pairRow("AUTO scheduled", s.autoScheduled, "upGood"),
    valueRow("Held by a person (vetoes)", countValue(s.vetoed, "neutral")),
    // Auto-rejects are routine (the gate doing its job): neutral, not red every week.
    valueRow("Auto-rejected", countValue(s.autoRejected?.count ?? null, "neutral")),
    ...(s.autoRejected?.topReasons ?? []).map(([reason, count]) => detailRow(`${count} × ${reason}`)),
  ];
  const autopilot = [
    valueRow(
      "Stage",
      s.autopilot
        ? `${span(s.autopilot.stage, COLOR.text, "font-weight:600;")}${s.autopilot.enabled ? "" : span(" (kill switch OFF)", COLOR.bad, "font-weight:600;")}`
        : NA,
    ),
    ...(s.autopilot?.reason ? [detailRow(s.autopilot.reason)] : []),
    valueRow("Breaker trips this week", countValue(s.breakerTrips, "upBad")),
  ];
  const learning: string[] = [];
  if (!s.topArms) learning.push(valueRow("Top arms", NA));
  else if (s.topArms.length === 0) learning.push(valueRow("Top arms", span("none yet", COLOR.secondary)));
  else {
    learning.push(valueRow("Top arms by trials", ""));
    for (const a of s.topArms) {
      const rate = a.rate === null ? "too early" : `${(a.rate * 100).toFixed(1)}% reward rate (${a.confidence})`;
      learning.push(detailRow(`${a.learner} / ${a.key}: ${a.trials} trials, ${rate}`));
    }
  }
  if (!s.insights) learning.push(valueRow("Insights this week", NA));
  else {
    const kinds = s.insights.byKind.map(([k, v]) => `${k} ${v}`).join(", ");
    learning.push(valueRow("Insights this week", countValue(s.insights.count, "neutral", aside(kinds ? ` (${kinds})` : ""))));
    for (const t of s.insights.titles) learning.push(detailRow(`- ${t.slice(0, 120)}`));
  }
  const ex = s.exemplars;
  learning.push(
    valueRow(
      "Exemplars",
      ex.enabled ? span("on", COLOR.good, "font-weight:600;") : `${span("off", COLOR.text, "font-weight:600;")}${span(" (EXEMPLARS_ENABLED unset)", COLOR.secondary)}`,
    ),
    valueRow(
      "Past pitches that qualify",
      `${countValue(ex.qualifying?.count ?? null, "neutral")}${worthTurningOn(ex) ? span(" worth turning on", COLOR.good, "font-weight:600;") : ""}`,
    ),
  );
  if (ex.qualifying && ex.qualifying.count > 0) learning.push(detailRow(`${exemplarLangs(ex.qualifying)}; top: ${exemplarTop(ex.qualifying)}`));
  const health = [
    valueRow(
      "AI spend",
      `${s.aiSpendUsd === null ? NA : span(usd(s.aiSpendUsd), COLOR.text, "font-weight:600;")}${span(` of ${usd(s.aiCapUsd)} weekly cap`, COLOR.secondary)}`,
    ),
    detailRow("Weekly cap = 7 × daily cap"),
    valueRow(
      "Warmup inbox placement",
      s.placement
        ? `${span(`${Math.round((s.placement.inbox / s.placement.checked) * 100)}% inbox`, COLOR.text, "font-weight:600;")}${span(` (${s.placement.inbox}/${s.placement.checked} checked)`, COLOR.secondary)}`
        : `${NA}${span(" (not measured this week)", COLOR.muted)}`,
    ),
    valueRow("Emergencies raised", countValue(s.alerts?.count ?? null, "upBad", aside(s.alerts?.kinds.length ? ` (${s.alerts.kinds.join(", ")})` : ""))),
  ];

  const summary = summaryOf(s);
  const analytics = `${appUrl}/analytics`;
  const gap = `<td width="8" style="width:8px;font-size:0;line-height:0;">&nbsp;</td>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">` +
    `<title>S.P.A.M. weekly</title></head>` +
    `<body style="margin:0;padding:0;background-color:${COLOR.page};">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLOR.page}" style="background-color:${COLOR.page};">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">` +
    // Header
    `<tr><td style="padding:0 0 16px;font-family:${FONT};color:${COLOR.text};">` +
    `<div style="font-size:22px;line-height:28px;font-weight:700;">S.P.A.M. weekly</div>` +
    `<div style="font-size:13px;line-height:20px;color:${COLOR.secondary};">${esc(`${day(s.from)} to ${day(s.to)}`)} · last 7 days vs the 7 before</div>` +
    (summary ? `<div style="font-size:15px;line-height:22px;padding-top:6px;color:${COLOR.text};">${esc(summary)}</div>` : "") +
    `</td></tr>` +
    // KPI tiles
    `<tr><td style="padding:0 0 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    tile("First emails", s.firstEmails) +
    gap +
    tile("Replies", s.replies) +
    gap +
    tile("Meetings", s.meetings) +
    `</tr></table></td></tr>` +
    // Sections
    card("OUTREACH", outreach, true) +
    card("PIPELINE", pipeline, true) +
    card("AUTOPILOT", autopilot, false) +
    card("LEARNING", learning, false) +
    card("HEALTH", health, false) +
    // Button
    `<tr><td align="center" style="padding:4px 0 16px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td bgcolor="${COLOR.button}" style="background-color:${COLOR.button};border-radius:6px;">` +
    `<a href="${esc(analytics)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">Open analytics</a>` +
    `</td></tr></table></td></tr>` +
    // Footer
    `<tr><td align="center" style="font-family:${FONT};font-size:12px;line-height:18px;color:${COLOR.secondary};">Test addresses are excluded. n/a = no data.</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

// ── Route orchestration (deps injected so tests run it in memory) ──────────────

export type WeeklyRouteDeps = {
  authorize: (req: Request) => Promise<boolean>;
  tenantIds: () => Promise<string[]>;
  gather: (tenantId: string, now: Date) => Promise<WeeklyRaw>;
  /** body = the plain-text part, html = the designed HTML part (lib/notify/send.ts NotificationMessage). */
  send: (tenantId: string, message: { subject: string; body: string; html?: string }) => Promise<{ sent: number; failed: string[] }>;
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
      const stats = buildWeeklyStats(raw);
      const message = { ...formatWeeklyReport(stats, raw.appUrl), html: formatWeeklyReportHtml(stats, raw.appUrl) };
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
