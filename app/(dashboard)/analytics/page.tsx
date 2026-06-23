import {
  BrainCircuit,
  DollarSign,
  FlaskConical,
  MessageSquare,
  TrendingUp,
  Users,
} from "lucide-react";
import { requireUser } from "@/lib/auth";
import {
  getCostSummary,
  getDailySpend,
  getIcpLeaderboard,
  getPipelineCounts,
  getPitchStats,
  getReplyIntents,
} from "@/lib/analytics/queries";
import {
  getOutcomeInsights,
  type OutcomeConfidence,
  type OutcomeDimension,
  type OutcomeInsights,
} from "@/lib/analytics/outcomes";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number, decimals = 0) {
  return n.toLocaleString("en-US", { maximumFractionDigits: decimals });
}

function fmtUsd(n: number) {
  if (n < 0.01) return "$0.00";
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function pct(num: number, den: number) {
  if (den === 0) return "—";
  return `${Math.round((num / den) * 100)}%`;
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-lg p-4"
      style={{
        background: "var(--color-bg-800)",
        border: "1px solid var(--color-border-subtle)",
      }}
    >
      <span
        className="text-[11px] uppercase tracking-wider"
        style={{ color: "var(--color-fg-500)" }}
      >
        {label}
      </span>
      <span
        className="text-2xl font-semibold tabular-nums"
        style={{ color: accent ?? "var(--color-fg-50)" }}
      >
        {value}
      </span>
      {sub && (
        <span className="text-xs" style={{ color: "var(--color-fg-500)" }}>
          {sub}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bar — CSS only, no lib
// ---------------------------------------------------------------------------

function HBar({
  label,
  value,
  max,
  color,
  subLabel,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
  subLabel?: string;
}) {
  const width = max > 0 ? Math.max((value / max) * 100, value > 0 ? 2 : 0) : 0;
  return (
    <div className="flex items-center gap-3">
      <span
        className="w-28 shrink-0 truncate text-right text-[11px]"
        style={{ color: "var(--color-fg-500)" }}
        title={label}
      >
        {label}
      </span>
      <div
        className="relative h-5 flex-1 overflow-hidden rounded-sm"
        style={{ background: "var(--color-bg-700)" }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-sm transition-all duration-500"
          style={{
            width: `${width}%`,
            background: `color-mix(in oklab, ${color}, transparent 35%)`,
            boxShadow:
              value > 0
                ? `0 0 8px color-mix(in oklab, ${color}, transparent 55%)`
                : undefined,
          }}
        />
        <span
          className="absolute inset-y-0 left-2 flex items-center text-[11px] font-medium tabular-nums"
          style={{
            color:
              value > 0 ? "var(--color-fg-50)" : "var(--color-fg-700)",
          }}
        >
          {fmt(value)}
        </span>
      </div>
      {subLabel && (
        <span
          className="w-10 shrink-0 text-right text-[11px] tabular-nums"
          style={{ color: "var(--color-fg-700)" }}
        >
          {subLabel}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline — SVG polyline, no external lib
// ---------------------------------------------------------------------------

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values, 0.001);
  const W = 160;
  const H = 36;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = H - (v / max) * (H - 4);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      style={{ overflow: "visible" }}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.7"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionHeader({
  icon: Icon,
  title,
}: {
  icon: React.ElementType;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon
        className="h-4 w-4"
        style={{ color: "var(--color-accent-300)" }}
        aria-hidden
      />
      <h2
        className="text-sm font-semibold uppercase tracking-wider"
        style={{ color: "var(--color-fg-300)" }}
      >
        {title}
      </h2>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Color maps
// ---------------------------------------------------------------------------

const STAGE_COLOR: Record<string, string> = {
  raw: "var(--color-fg-500)",
  researched: "var(--color-info-300)",
  pitched: "var(--color-accent-300)",
  replied: "var(--color-brand-gold)",
  booked: "var(--color-brand-pink)",
  won: "var(--color-success-300)",
  lost: "var(--color-fg-700)",
};

const INTENT_COLOR: Record<string, string> = {
  wants_meeting: "var(--color-success-300)",
  wants_info: "var(--color-brand-gold)",
  not_now: "var(--color-fg-500)",
  wrong_person: "var(--color-fg-700)",
  hard_no: "var(--color-brand-pink)",
  auto_reply: "var(--color-fg-700)",
  unclassified: "var(--color-fg-700)",
};

const INTENT_LABEL: Record<string, string> = {
  wants_meeting: "Wants meeting",
  wants_info: "Wants info",
  not_now: "Not now",
  wrong_person: "Wrong person",
  hard_no: "Hard no",
  auto_reply: "Auto-reply",
  unclassified: "Unclassified",
};

const COST_CAT_COLOR: Record<string, string> = {
  research: "var(--color-info-300)",
  pitch: "var(--color-accent-300)",
  scoring: "var(--color-brand-gold)",
  reply_classify: "var(--color-brand-pink)",
  icp_suggest: "var(--color-success-300)",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Outcome learning (Phase 2a — observation only)
// ---------------------------------------------------------------------------

const CONFIDENCE_META: Record<
  OutcomeConfidence,
  { label: string; color: string }
> = {
  actionable: { label: "actionable", color: "var(--color-success-300)" },
  emerging: { label: "emerging", color: "var(--color-brand-gold)" },
  insufficient: { label: "n<5", color: "var(--color-fg-700)" },
};

function ConfidenceBadge({ confidence }: { confidence: OutcomeConfidence }) {
  const m = CONFIDENCE_META[confidence];
  return (
    <span
      className="rounded-sm px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider"
      style={{
        color: m.color,
        background: `color-mix(in oklab, ${m.color}, transparent 88%)`,
      }}
    >
      {m.label}
    </span>
  );
}

function DimensionTable({ dim }: { dim: OutcomeDimension }) {
  const rows = dim.rows.slice(0, 6);
  const extra = dim.rows.length - rows.length;

  return (
    <div
      className="flex flex-col gap-2 rounded-lg p-4"
      style={{
        background: "var(--color-bg-800)",
        border: "1px solid var(--color-border-subtle)",
      }}
    >
      <span
        className="text-[11px] font-medium uppercase tracking-wider"
        style={{ color: "var(--color-fg-500)" }}
      >
        {dim.label}
      </span>
      {rows.length === 0 ? (
        <p className="py-3 text-xs" style={{ color: "var(--color-fg-700)" }}>
          No data on this dimension yet.
        </p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
              {["", "Sent", "Repl", "Rate", ""].map((h, i) => (
                <th
                  key={i}
                  className="pb-1 text-right text-[10px] font-medium uppercase tracking-wider first:text-left"
                  style={{ color: "var(--color-fg-700)" }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className="border-b last:border-0"
                style={{ borderColor: "var(--color-border-subtle)" }}
              >
                <td className="py-1.5 pr-2">
                  <span
                    className="block max-w-[140px] truncate"
                    style={{ color: "var(--color-fg-200)" }}
                    title={`${r.label} · ${fmt(r.prospects)} prospects`}
                  >
                    {r.label || "—"}
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums" style={{ color: "var(--color-fg-300)" }}>
                  {fmt(r.sent)}
                </td>
                <td className="py-1.5 text-right tabular-nums" style={{ color: "var(--color-fg-300)" }}>
                  {fmt(r.replied)}
                </td>
                <td
                  className="py-1.5 text-right tabular-nums"
                  style={{
                    color:
                      r.confidence === "insufficient"
                        ? "var(--color-fg-700)"
                        : r.replyRate !== null && r.replyRate > 0.1
                          ? "var(--color-success-300)"
                          : "var(--color-fg-300)",
                  }}
                >
                  {/* Don't show a rate we can't trust — gate on confidence. */}
                  {r.confidence === "insufficient" || r.replyRate === null
                    ? "—"
                    : pct(r.replied, r.sent)}
                </td>
                <td className="py-1.5 pl-2 text-right">
                  <ConfidenceBadge confidence={r.confidence} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {extra > 0 && (
        <span className="text-[10px]" style={{ color: "var(--color-fg-700)" }}>
          +{extra} more
        </span>
      )}
    </div>
  );
}

function OutcomeLearning({ insights }: { insights: OutcomeInsights }) {
  return (
    <section
      className="flex flex-col gap-4 rounded-xl p-5"
      style={{
        background: "var(--color-bg-800)",
        border: "1px solid var(--color-border-subtle)",
      }}
    >
      <SectionHeader icon={FlaskConical} title="Outcome learning" />

      {/* Honest framing — this is observation, not auto-tuning. */}
      <div
        className="flex flex-col gap-1 rounded-lg p-3 text-[11px]"
        style={{
          background: "color-mix(in oklab, var(--color-brand-gold), transparent 92%)",
          border: "1px solid color-mix(in oklab, var(--color-brand-gold), transparent 75%)",
          color: "var(--color-fg-300)",
        }}
      >
        <span style={{ color: "var(--color-brand-gold)" }}>
          Phase 2a · observation only
        </span>
        <span>
          Nothing here changes targeting or scoring. Reply rates stay hidden (“—”)
          until a segment has ≥5 sends (<strong>emerging</strong>) and are only
          dependable at ≥20 (<strong>actionable</strong>). Statistical reweighting
          (Phase 2b) is gated on this volume — it waits until the numbers are real.
        </span>
      </div>

      {/* Global outcome totals */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Sent" value={fmt(insights.totalSent)} sub="pitches shipped" />
        <StatCard
          label="Replied"
          value={fmt(insights.totalReplied)}
          sub={pct(insights.totalReplied, insights.totalSent) + " of sent"}
          accent="var(--color-brand-gold)"
        />
        <StatCard
          label="Booked"
          value={fmt(insights.totalBooked)}
          sub={pct(insights.totalBooked, insights.totalSent) + " of sent"}
          accent="var(--color-success-300)"
        />
      </div>

      {!insights.hasReadableData && (
        <p
          className="rounded-lg px-3 py-2 text-xs"
          style={{
            background: "var(--color-bg-900)",
            color: "var(--color-fg-500)",
          }}
        >
          Not enough outcomes yet to read any segment ({fmt(insights.totalSent)}{" "}
          sent so far). As pitches send and replies land, these tables light up —
          this is the data flywheel starting, exactly as designed.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {insights.dimensions.map((dim) => (
          <DimensionTable key={dim.key} dim={dim} />
        ))}
      </div>
    </section>
  );
}

export default async function AnalyticsPage() {
  const user = await requireUser();

  const [pipeline, pitchStats, costSummary, dailySpend, replyIntents, icpRows, outcomes] =
    await Promise.all([
      getPipelineCounts(user.tenantId),
      getPitchStats(user.tenantId),
      getCostSummary(user.tenantId),
      getDailySpend(user.tenantId),
      getReplyIntents(user.tenantId),
      getIcpLeaderboard(user.tenantId),
      getOutcomeInsights(user.tenantId),
    ]);

  const totalProspects = pipeline.reduce((a, s) => a + s.count, 0);
  const sentCount = pitchStats.sent;
  const repliedCount =
    (pipeline.find((s) => s.status === "replied")?.count ?? 0) +
    (pipeline.find((s) => s.status === "booked")?.count ?? 0) +
    (pipeline.find((s) => s.status === "won")?.count ?? 0);
  const replyRate = sentCount > 0 ? repliedCount / sentCount : 0;

  const dailyValues = dailySpend.map((d) => d.total_usd);
  const maxCost = Math.max(
    ...costSummary.byCategory.map((c) => c.total_usd),
    0.001,
  );
  const maxPipeline = Math.max(...pipeline.map((s) => s.count), 1);

  const rawCount = pipeline.find((s) => s.status === "raw")?.count ?? 0;
  const researchedCount =
    pipeline.find((s) => s.status === "researched")?.count ?? 0;
  const pitchedCount =
    pipeline.find((s) => s.status === "pitched")?.count ?? 0;
  const wonCount = pipeline.find((s) => s.status === "won")?.count ?? 0;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* ── Header ── */}
      <header
        className="sticky top-0 z-10 flex items-center border-b px-6 py-4"
        style={{
          background: "var(--color-bg-900)",
          borderColor: "var(--color-border-subtle)",
        }}
      >
        <div
          className="relative pl-4"
          style={{
            background:
              "radial-gradient(ellipse 55% 80% at 0% 50%, color-mix(in oklab, var(--color-accent-300), transparent 92%) 0%, transparent 100%)",
          }}
        >
          <span
            className="absolute left-0 top-0 bottom-0 w-0.5 rounded-full"
            style={{
              background:
                "linear-gradient(to bottom, var(--color-accent-300), var(--color-brand-pink))",
            }}
            aria-hidden
          />
          <h1
            className="text-2xl font-semibold tracking-tight"
            style={{ color: "var(--color-fg-50)" }}
          >
            Analytics
          </h1>
          <p className="text-sm" style={{ color: "var(--color-fg-500)" }}>
            {fmt(totalProspects)} prospects · {fmt(pitchStats.total)} pitches ·{" "}
            {fmt(replyIntents.reduce((a, r) => a + r.count, 0))} replies
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-8 p-6">
        {/* ── Row 1: Top-line KPIs ── */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="Total prospects"
            value={fmt(totalProspects)}
            sub={`${fmt(rawCount)} raw · ${fmt(researchedCount)} researched`}
          />
          <StatCard
            label="Pitches sent"
            value={fmt(sentCount)}
            sub={`${fmt(pitchStats.total)} total incl. drafts`}
            accent="var(--color-accent-300)"
          />
          <StatCard
            label="Reply rate"
            value={sentCount === 0 ? "—" : `${Math.round(replyRate * 100)}%`}
            sub={`${fmt(repliedCount)} replied / booked / won`}
            accent={
              replyRate > 0.1
                ? "var(--color-success-300)"
                : replyRate > 0.05
                  ? "var(--color-brand-gold)"
                  : "var(--color-fg-50)"
            }
          />
          <StatCard
            label="Deals won"
            value={fmt(wonCount)}
            sub={pct(wonCount, sentCount) + " of sent"}
            accent={
              wonCount > 0 ? "var(--color-success-300)" : "var(--color-fg-50)"
            }
          />
        </section>

        {/* ── Row 2: Pipeline funnel + Pitch quality ── */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Pipeline funnel */}
          <section
            className="flex flex-col gap-4 rounded-xl p-5"
            style={{
              background: "var(--color-bg-800)",
              border: "1px solid var(--color-border-subtle)",
            }}
          >
            <SectionHeader icon={TrendingUp} title="Pipeline funnel" />
            <div className="flex flex-col gap-2">
              {pipeline.map((stage) => (
                <HBar
                  key={stage.status}
                  label={
                    stage.status.charAt(0).toUpperCase() +
                    stage.status.slice(1)
                  }
                  value={stage.count}
                  max={maxPipeline}
                  color={STAGE_COLOR[stage.status] ?? "var(--color-fg-500)"}
                  subLabel={
                    totalProspects > 0
                      ? pct(stage.count, totalProspects)
                      : undefined
                  }
                />
              ))}
            </div>
            <div
              className="mt-1 grid grid-cols-3 gap-2 rounded-lg p-3"
              style={{ background: "var(--color-bg-700)" }}
            >
              <div className="flex flex-col items-center gap-0.5">
                <span
                  className="text-[10px] uppercase tracking-wider"
                  style={{ color: "var(--color-fg-700)" }}
                >
                  Research rate
                </span>
                <span
                  className="text-base font-semibold tabular-nums"
                  style={{ color: "var(--color-info-300)" }}
                >
                  {pct(
                    researchedCount,
                    rawCount + researchedCount,
                  )}
                </span>
              </div>
              <div className="flex flex-col items-center gap-0.5">
                <span
                  className="text-[10px] uppercase tracking-wider"
                  style={{ color: "var(--color-fg-700)" }}
                >
                  Pitch rate
                </span>
                <span
                  className="text-base font-semibold tabular-nums"
                  style={{ color: "var(--color-accent-300)" }}
                >
                  {pct(pitchedCount, researchedCount + pitchedCount)}
                </span>
              </div>
              <div className="flex flex-col items-center gap-0.5">
                <span
                  className="text-[10px] uppercase tracking-wider"
                  style={{ color: "var(--color-fg-700)" }}
                >
                  Reply rate
                </span>
                <span
                  className="text-base font-semibold tabular-nums"
                  style={{ color: "var(--color-brand-gold)" }}
                >
                  {sentCount === 0 ? "—" : `${Math.round(replyRate * 100)}%`}
                </span>
              </div>
            </div>
          </section>

          {/* Pitch quality */}
          <section
            className="flex flex-col gap-4 rounded-xl p-5"
            style={{
              background: "var(--color-bg-800)",
              border: "1px solid var(--color-border-subtle)",
            }}
          >
            <SectionHeader icon={BrainCircuit} title="Pitch quality" />
            <div className="grid grid-cols-2 gap-3">
              <StatCard
                label="Avg quality score"
                value={
                  pitchStats.avgQualityScore !== null
                    ? `${pitchStats.avgQualityScore}/10`
                    : "—"
                }
                sub="Claude self-score"
                accent={
                  (pitchStats.avgQualityScore ?? 0) >= 7
                    ? "var(--color-success-300)"
                    : (pitchStats.avgQualityScore ?? 0) >= 5
                      ? "var(--color-brand-gold)"
                      : "var(--color-brand-pink)"
                }
              />
              <StatCard
                label="Auto-rejected"
                value={pct(pitchStats.autoRejected, pitchStats.total)}
                sub={`${fmt(pitchStats.autoRejected)} of ${fmt(pitchStats.total)}`}
                accent={
                  pitchStats.autoRejected === 0 || pitchStats.total === 0
                    ? "var(--color-success-300)"
                    : "var(--color-brand-pink)"
                }
              />
            </div>

            {/* Claude vs heuristic */}
            <div
              className="flex flex-col gap-2 rounded-lg p-4"
              style={{ background: "var(--color-bg-700)" }}
            >
              <span
                className="text-[10px] uppercase tracking-wider"
                style={{ color: "var(--color-fg-700)" }}
              >
                AI draft acceptance
              </span>
              <div className="flex items-center gap-3">
                <div
                  className="h-4 flex-1 overflow-hidden rounded-sm"
                  style={{ background: "var(--color-bg-600)" }}
                >
                  {pitchStats.total > 0 && (
                    <div
                      className="h-full rounded-sm transition-all"
                      style={{
                        width: `${(pitchStats.claudeGenerated / pitchStats.total) * 100}%`,
                        background:
                          "color-mix(in oklab, var(--color-accent-300), transparent 30%)",
                      }}
                    />
                  )}
                </div>
                <span
                  className="w-20 shrink-0 text-right text-xs tabular-nums"
                  style={{ color: "var(--color-fg-300)" }}
                >
                  {pct(pitchStats.claudeGenerated, pitchStats.total)} Claude
                </span>
              </div>
              <div
                className="flex justify-between text-[11px]"
                style={{ color: "var(--color-fg-700)" }}
              >
                <span>
                  {fmt(pitchStats.claudeGenerated)} Claude-written accepted
                </span>
                <span>{fmt(pitchStats.heuristicFallback)} auto-rejected</span>
              </div>
            </div>

            {pitchStats.reviewerRejected > 0 && (
              <div
                className="flex items-center justify-between rounded-lg px-4 py-2.5"
                style={{
                  background:
                    "color-mix(in oklab, var(--color-brand-pink), transparent 88%)",
                  border:
                    "1px solid color-mix(in oklab, var(--color-brand-pink), transparent 70%)",
                }}
              >
                <span
                  className="text-xs"
                  style={{ color: "var(--color-fg-500)" }}
                >
                  Reviewer-rejected (manual)
                </span>
                <span
                  className="text-sm font-semibold tabular-nums"
                  style={{ color: "var(--color-brand-pink)" }}
                >
                  {fmt(pitchStats.reviewerRejected)}
                </span>
              </div>
            )}
          </section>
        </div>

        {/* ── Row 3: AI spend + Reply signals ── */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* AI spend */}
          <section
            className="flex flex-col gap-4 rounded-xl p-5"
            style={{
              background: "var(--color-bg-800)",
              border: "1px solid var(--color-border-subtle)",
            }}
          >
            <SectionHeader icon={DollarSign} title="AI spend" />
            <div className="flex items-end justify-between">
              <div className="flex flex-col gap-0.5">
                <span
                  className="text-[11px] uppercase tracking-wider"
                  style={{ color: "var(--color-fg-500)" }}
                >
                  Total (all time)
                </span>
                <span
                  className="text-3xl font-semibold tabular-nums"
                  style={{ color: "var(--color-fg-50)" }}
                >
                  {fmtUsd(costSummary.totalUsd)}
                </span>
                <span
                  className="text-xs"
                  style={{ color: "var(--color-fg-500)" }}
                >
                  {fmtUsd(costSummary.last30DaysUsd)} last 30 days
                </span>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span
                  className="text-[10px]"
                  style={{ color: "var(--color-fg-700)" }}
                >
                  14-day trend
                </span>
                <Sparkline
                  values={dailyValues}
                  color="var(--color-accent-300)"
                />
              </div>
            </div>

            {costSummary.perPitchUsd !== null && (
              <div
                className="flex items-center justify-between rounded-lg px-4 py-2.5"
                style={{ background: "var(--color-bg-700)" }}
              >
                <span
                  className="text-xs"
                  style={{ color: "var(--color-fg-500)" }}
                >
                  Est. cost per pitch (last 30d)
                </span>
                <span
                  className="text-sm font-semibold tabular-nums"
                  style={{ color: "var(--color-accent-300)" }}
                >
                  {fmtUsd(costSummary.perPitchUsd)}
                </span>
              </div>
            )}

            <div className="flex flex-col gap-2">
              {costSummary.byCategory.map((cat) => (
                <HBar
                  key={cat.category}
                  label={cat.category}
                  value={cat.total_usd}
                  max={maxCost}
                  color={COST_CAT_COLOR[cat.category] ?? "var(--color-fg-500)"}
                  subLabel={fmtUsd(cat.total_usd)}
                />
              ))}
              {costSummary.byCategory.length === 0 && (
                <p
                  className="py-4 text-center text-sm"
                  style={{ color: "var(--color-fg-700)" }}
                >
                  No AI spend recorded yet
                </p>
              )}
            </div>
          </section>

          {/* Reply signals */}
          <section
            className="flex flex-col gap-4 rounded-xl p-5"
            style={{
              background: "var(--color-bg-800)",
              border: "1px solid var(--color-border-subtle)",
            }}
          >
            <SectionHeader icon={MessageSquare} title="Reply signals" />

            {replyIntents.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12">
                <MessageSquare
                  className="h-8 w-8"
                  style={{ color: "var(--color-fg-700)" }}
                />
                <p
                  className="text-center text-sm"
                  style={{ color: "var(--color-fg-700)" }}
                >
                  No replies classified yet.
                  <br />
                  Signals appear here as replies come in.
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-6">
                  {["wants_meeting", "wants_info", "hard_no"].map((intent) => {
                    const row = replyIntents.find((r) => r.intent === intent);
                    if (!row) return null;
                    return (
                      <div key={intent} className="flex flex-col gap-0.5">
                        <span
                          className="text-[10px] uppercase tracking-wider"
                          style={{
                            color:
                              INTENT_COLOR[intent] ?? "var(--color-fg-700)",
                          }}
                        >
                          {INTENT_LABEL[intent]}
                        </span>
                        <span
                          className="text-xl font-semibold tabular-nums"
                          style={{ color: "var(--color-fg-50)" }}
                        >
                          {fmt(row.count)}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-col gap-2">
                  {replyIntents.map((row) => {
                    const total = replyIntents.reduce(
                      (a, r) => a + r.count,
                      0,
                    );
                    return (
                      <HBar
                        key={row.intent}
                        label={INTENT_LABEL[row.intent] ?? row.intent}
                        value={row.count}
                        max={Math.max(
                          ...replyIntents.map((r) => r.count),
                          1,
                        )}
                        color={
                          INTENT_COLOR[row.intent] ?? "var(--color-fg-500)"
                        }
                        subLabel={pct(row.count, total)}
                      />
                    );
                  })}
                </div>
              </>
            )}
          </section>
        </div>

        {/* ── Outcome learning (Phase 2a — observation only) ── */}
        <OutcomeLearning insights={outcomes} />

        {/* ── Row 4: ICP leaderboard ── */}
        <section
          className="flex flex-col gap-4 rounded-xl p-5"
          style={{
            background: "var(--color-bg-800)",
            border: "1px solid var(--color-border-subtle)",
          }}
        >
          <SectionHeader icon={Users} title="ICP leaderboard" />

          {icpRows.length === 0 ? (
            <p
              className="py-6 text-center text-sm"
              style={{ color: "var(--color-fg-700)" }}
            >
              No active ICPs found. Create ICPs in Settings to segment your
              pipeline.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr
                    style={{
                      borderBottom: "1px solid var(--color-border-subtle)",
                    }}
                  >
                    {[
                      "ICP",
                      "Prospects",
                      "Pitched",
                      "Replied",
                      "Won",
                      "Reply rate",
                    ].map((h) => (
                      <th
                        key={h}
                        className="pb-2 text-right text-[11px] font-medium uppercase tracking-wider first:text-left"
                        style={{ color: "var(--color-fg-700)" }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {icpRows.map((row) => (
                    <tr
                      key={row.icp_id ?? "__none__"}
                      className="border-b last:border-0"
                      style={{ borderColor: "var(--color-border-subtle)" }}
                    >
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2">
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{
                              background:
                                row.icp_id !== null
                                  ? "var(--color-accent-300)"
                                  : "var(--color-fg-700)",
                              boxShadow:
                                row.icp_id !== null
                                  ? "0 0 4px var(--color-accent-300)"
                                  : undefined,
                            }}
                          />
                          <span
                            className="font-medium"
                            style={{
                              color:
                                row.icp_id !== null
                                  ? "var(--color-fg-50)"
                                  : "var(--color-fg-700)",
                            }}
                          >
                            {row.icp_name}
                          </span>
                        </div>
                      </td>
                      <td
                        className="py-2.5 text-right tabular-nums"
                        style={{ color: "var(--color-fg-300)" }}
                      >
                        {fmt(row.prospects)}
                      </td>
                      <td
                        className="py-2.5 text-right tabular-nums"
                        style={{
                          color:
                            row.pitched > 0
                              ? "var(--color-accent-300)"
                              : "var(--color-fg-700)",
                        }}
                      >
                        {fmt(row.pitched)}
                      </td>
                      <td
                        className="py-2.5 text-right tabular-nums"
                        style={{
                          color:
                            row.replied > 0
                              ? "var(--color-brand-gold)"
                              : "var(--color-fg-700)",
                        }}
                      >
                        {fmt(row.replied)}
                      </td>
                      <td
                        className="py-2.5 text-right tabular-nums"
                        style={{
                          color:
                            row.won > 0
                              ? "var(--color-success-300)"
                              : "var(--color-fg-700)",
                        }}
                      >
                        {fmt(row.won)}
                      </td>
                      <td
                        className="py-2.5 text-right tabular-nums"
                        style={{
                          color:
                            row.pitched > 0 && row.replied / row.pitched > 0.1
                              ? "var(--color-success-300)"
                              : "var(--color-fg-500)",
                        }}
                      >
                        {pct(row.replied, row.pitched)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Row 5: Per-category cost strip ── */}
        {costSummary.byCategory.length > 0 && (
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(["research", "pitch", "scoring", "reply_classify"] as const).map(
              (cat) => {
                const found = costSummary.byCategory.find(
                  (c) => c.category === cat,
                );
                return (
                  <StatCard
                    key={cat}
                    label={`${cat} cost`}
                    value={found ? fmtUsd(found.total_usd) : "$0.00"}
                    sub="all time"
                    accent={COST_CAT_COLOR[cat]}
                  />
                );
              },
            )}
          </section>
        )}
      </div>
    </div>
  );
}
