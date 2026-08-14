"use client";

import React from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Flame,
  Inbox,
  Mail,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  Shield,
  TrendingUp,
  XCircle,
  Zap,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type {
  WarmupConfig,
  WarmupLogEntry,
  DomainHealth,
} from "@/lib/warmup/types";
import {
  resolveDailyTarget,
  resolvePhaseLabel,
  isRewarming,
  RAMP_SCHEDULE,
  MAINTENANCE_DAILY_TARGET,
} from "@/lib/warmup/types";
import { deriveDomainHealth } from "@/lib/warmup/health-score";
import { analyzeSpamRate, buildAlerts } from "@/lib/warmup/intelligence";
import type { DeliverabilityHealth } from "@/lib/warmup/deliverability";
import type { DmarcSummary } from "@/lib/warmup/dmarc-summary";
import { pauseWarmup, resumeWarmup, triggerEngineManually, rewarmNow, stopRewarm } from "./warmup-actions";

// ── Props ──────────────────────────────────────────────────────────────────────

type Props = {
  config: WarmupConfig | null;
  recentLog: WarmupLogEntry[];
  healthHistory: DomainHealth[];
  latestHealth: DomainHealth | null;
  totalSent: number;
  deliverability: DeliverabilityHealth | null;
  dmarc: DmarcSummary | null;
};

// ── Deliverability Health panel (low-volume, works from email #1) ─────────────

function CheckRow({
  label,
  check,
}: {
  label: string;
  check: { status: "pass" | "warn" | "fail" | "unknown"; detail: string };
}) {
  const dot =
    check.status === "pass"
      ? "bg-green-500"
      : check.status === "warn"
        ? "bg-yellow-500"
        : check.status === "fail"
          ? "bg-red-500"
          : "bg-neutral-400";
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span className="w-16 shrink-0 text-xs font-medium text-neutral-300">{label}</span>
      <span className="text-xs text-neutral-500">{check.detail}</span>
    </div>
  );
}

// ── DMARC aggregate-report panel (low-volume spoofing/abuse signal) ───────────

function DmarcPanel({ dmarc }: { dmarc: DmarcSummary }) {
  if (dmarc.reports === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3">
        <div className="mb-1 text-xs font-medium text-neutral-400">
          DMARC aggregate reports
        </div>
        <p className="text-xs text-neutral-500">
          No reports yet. Mailbox providers send daily once they see mail from
          your domain — they land in pedro@runnareach.com and sync automatically.
        </p>
      </div>
    );
  }

  const pct = dmarc.pass_rate === null ? null : Math.round(dmarc.pass_rate * 100);
  const passColor =
    pct === null
      ? "text-neutral-400"
      : pct >= 95
        ? "text-green-600"
        : pct >= 80
          ? "text-yellow-600"
          : "text-red-500";

  const hasAbuse = dmarc.failed_alignment.length > 0 || dmarc.non_google.length > 0;

  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-400">
          DMARC alignment (reports, {dmarc.window_days}d)
        </span>
        <span className={`text-xs font-semibold ${passColor}`}>
          {pct === null ? "—" : `${pct}% pass`}
        </span>
      </div>
      <p className="text-[10px] text-neutral-500">
        {dmarc.aligned_pass_messages.toLocaleString()} of{" "}
        {dmarc.total_messages.toLocaleString()} reported messages aligned ·{" "}
        {dmarc.reports} report{dmarc.reports === 1 ? "" : "s"}
      </p>

      {!hasAbuse && (
        <div className="flex items-center gap-2 pt-1">
          <CheckCircle2 className="size-3.5 text-green-500 shrink-0" />
          <span className="text-xs text-neutral-500">
            No unauthorized sending sources detected.
          </span>
        </div>
      )}

      {dmarc.failed_alignment.length > 0 && (
        <DmarcFlagList
          title="Failed SPF + DKIM alignment (possible spoofing)"
          sources={dmarc.failed_alignment}
        />
      )}

      {dmarc.non_google.length > 0 && (
        <DmarcFlagList
          title="Sending sources outside Google's ranges (not your sender)"
          sources={dmarc.non_google}
        />
      )}
    </div>
  );
}

function DmarcFlagList({
  title,
  sources,
}: {
  title: string;
  sources: DmarcSummary["failed_alignment"];
}) {
  return (
    <div className="pt-1.5 border-t border-neutral-100 dark:border-neutral-800">
      <div className="mb-1 flex items-center gap-1.5">
        <AlertTriangle className="size-3 text-red-500 shrink-0" />
        <span className="text-[11px] font-medium text-red-500">{title}</span>
      </div>
      <div className="space-y-0.5">
        {sources.map((s) => (
          <div
            key={s.source_ip}
            className="flex items-center justify-between text-[11px] text-neutral-500"
          >
            <span className="font-mono truncate">{s.source_ip}</span>
            <span className="shrink-0 ml-2">
              {s.message_count.toLocaleString()} msg
              {s.header_from ? ` · ${s.header_from}` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Reputation badge ──────────────────────────────────────────────────────────

function ReputationBadge({
  value,
}: {
  value: DomainHealth["domain_reputation"];
}) {
  const map: Record<string, { label: string; color: string }> = {
    HIGH: { label: "HIGH", color: "text-green-600" },
    MEDIUM: { label: "MEDIUM", color: "text-yellow-600" },
    LOW: { label: "LOW", color: "text-orange-600" },
    BAD: { label: "BAD", color: "text-red-600" },
    REPUTATION_CATEGORY_UNSPECIFIED: { label: "UNKNOWN", color: "text-neutral-400" },
  };
  const { label, color } = map[value ?? "REPUTATION_CATEGORY_UNSPECIFIED"] ?? {
    label: "—",
    color: "text-neutral-400",
  };
  return <span className={`font-semibold ${color}`}>{label}</span>;
}

// ── Inbox rate gauge ──────────────────────────────────────────────────────────

function InboxRateGauge({ rate }: { rate: number | null }) {
  if (rate === null)
    return (
      <div className="text-sm text-neutral-400">Not enough data yet</div>
    );

  const pct = Math.round(rate * 100);
  const color =
    pct >= 90 ? "bg-green-500" : pct >= 70 ? "bg-yellow-500" : "bg-red-500";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-neutral-500">Inbox placement</span>
        <span className="font-semibold">{pct}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── Ring gauge (compact circular percentage) ──────────────────────────────────

function RingGauge({
  pct,
  color,
  label,
  size = 56,
}: {
  pct: number;
  color: string;
  label?: string;
  size?: number;
}) {
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * circ;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-neutral-200 dark:stroke-neutral-800"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          stroke={color}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ - dash}`}
          style={{ transition: "stroke-dasharray 0.6s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="text-sm font-bold">{Math.round(clamped)}%</span>
        {label ? <span className="text-[8px] text-neutral-400 mt-0.5">{label}</span> : null}
      </div>
    </div>
  );
}

// ── Derived domain health (used when Postmaster reputation is still UNKNOWN) ───
// At low volume Postmaster gives nothing, so we grade the domain from the signals
// we DO have: DMARC alignment pass rate + live DNS auth (SPF/DKIM/DMARC) + domain
// blocklist status. The scoring lives in lib/warmup/health-score.ts so the grade
// shown here and the grade the auto-reactivation loop acts on are the SAME number.

// ── Log entry row ─────────────────────────────────────────────────────────────

function LogRow({ entry }: { entry: WarmupLogEntry }) {
  const directionIcon =
    entry.direction === "sent" ? (
      <Mail className="size-3.5 text-blue-500" />
    ) : (
      <MessageSquare className="size-3.5 text-green-500" />
    );

  const inboxStatus =
    entry.landed_in_inbox === null ? (
      <span title="Checking…"><Clock className="size-3.5 text-neutral-300" /></span>
    ) : entry.landed_in_inbox ? (
      <span title="Landed in inbox"><CheckCircle2 className="size-3.5 text-green-500" /></span>
    ) : (
      <span title="Landed in spam"><XCircle className="size-3.5 text-red-500" /></span>
    );

  const date = new Date(entry.created_at);
  const timeStr = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dateStr = date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });

  return (
    <div className="flex items-center gap-3 py-2 border-b border-neutral-100 dark:border-neutral-800 last:border-0">
      <div className="shrink-0">{directionIcon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{entry.subject}</p>
        <p className="text-xs text-neutral-400">
          Day {entry.day_number} · {dateStr} {timeStr}
        </p>
      </div>
      <div className="shrink-0 flex items-center gap-1.5">
        {entry.direction === "sent" && inboxStatus}
        {entry.reply_sent && (
          <span title="Replied"><MessageSquare className="size-3.5 text-green-400" /></span>
        )}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function WarmupDashboard({
  config,
  recentLog,
  healthHistory: _healthHistory,
  latestHealth,
  totalSent,
  deliverability,
  dmarc,
}: Props) {
  const [isPending, startTransition] = React.useTransition();
  const [message, setMessage] = React.useState<string | null>(null);

  // Spam analysis from log
  const spamAnalysis = analyzeSpamRate(recentLog);

  // ── Low-volume fallbacks for the top cards ──────────────────────────────────
  // IMAP inbox-placement + Postmaster reputation stay blank until high volume,
  // so fall back to the DMARC + DNS signals we already have today.
  const hasImapRate = spamAnalysis.inboxRate !== null;
  const dmarcPct =
    dmarc && dmarc.pass_rate !== null ? Math.round(dmarc.pass_rate * 100) : null;
  // Inbox-rate card: real IMAP rate if we have it, else DMARC auth pass rate.
  const inboxPct = hasImapRate
    ? Math.round((spamAnalysis.inboxRate ?? 0) * 100)
    : dmarcPct;
  const inboxColor =
    inboxPct === null
      ? "#a3a3a3"
      : inboxPct >= 90
        ? "#22c55e"
        : inboxPct >= 70
          ? "#eab308"
          : "#ef4444";
  const postmasterRep = latestHealth?.domain_reputation ?? null;
  const hasPostmasterRep =
    postmasterRep !== null && postmasterRep !== "REPUTATION_CATEGORY_UNSPECIFIED";
  const derivedHealth = hasPostmasterRep ? null : deriveDomainHealth(dmarc, deliverability);

  // Alerts
  const alerts = config
    ? buildAlerts(config, spamAnalysis, latestHealth)
    : [];

  // Stats
  // Derive sentToday from log (always accurate — immune to counter race conditions
  // and page-load timing vs cron-fire timing)
  const todayUTC = new Date().toISOString().split("T")[0] ?? "";
  const sentToday = recentLog.filter(
    (l) =>
      l.direction === "sent" &&
      l.created_at.startsWith(todayUTC),
  ).length;
  const targetToday = config ? resolveDailyTarget(config) : 5;
  const phase = config ? resolvePhaseLabel(config) : "—";
  const rewarming = config ? isRewarming(config) : false;

  // Empty state
  if (!config) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-2">
          <Flame className="size-6 text-orange-500" />
          <h1 className="text-2xl font-bold">Email Warmup</h1>
        </div>
        <p className="text-neutral-500 mb-8">
          No warmup configuration found. Run the{" "}
          <code className="text-xs bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded">
            0016_warmup_system.sql
          </code>{" "}
          migration and insert a{" "}
          <code className="text-xs bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded">
            warmup_config
          </code>{" "}
          row to get started.
        </p>
        <div className="rounded-lg border border-dashed border-neutral-200 dark:border-neutral-700 p-8 text-center">
          <Zap className="size-10 mx-auto mb-3 text-neutral-300" />
          <p className="text-sm text-neutral-400">Warmup not yet configured</p>
        </div>
      </div>
    );
  }

  const statusColor =
    config.status === "active"
      ? "text-green-600"
      : config.status === "paused"
        ? "text-orange-500"
        : config.status === "completed"
          ? "text-blue-600"
          : "text-neutral-400";

  const statusIcon =
    config.status === "active" ? (
      <Activity className="size-4 text-green-500" />
    ) : config.status === "paused" ? (
      <AlertTriangle className="size-4 text-orange-500" />
    ) : (
      <CheckCircle2 className="size-4 text-blue-500" />
    );

  function handlePause() {
    startTransition(async () => {
      setMessage(null);
      const result = await pauseWarmup(config!.id);
      setMessage(result.ok ? "Warmup paused." : `Error: ${result.error}`);
    });
  }

  function handleResume() {
    startTransition(async () => {
      setMessage(null);
      const result = await resumeWarmup(config!.id);
      setMessage(result.ok ? "Warmup resumed." : `Error: ${result.error}`);
    });
  }

  function handleRewarm() {
    startTransition(async () => {
      setMessage(null);
      const result = await rewarmNow(config!.id);
      setMessage(
        result.ok
          ? `Re-warm started at ${result.target}/day — climbing back to full volume.`
          : `Error: ${result.error}`,
      );
    });
  }

  function handleStopRewarm() {
    startTransition(async () => {
      setMessage(null);
      const result = await stopRewarm(config!.id);
      setMessage(result.ok ? "Re-warm stopped — back to maintenance." : `Error: ${result.error}`);
    });
  }

  function handleManualTick() {
    startTransition(async () => {
      setMessage(null);
      const result = await triggerEngineManually();
      setMessage(
        result.ok
          ? `Engine tick complete — sent ${result.sent ?? 0} email(s).` +
              (result.sent === 0 && result.reasons.length > 0
                ? ` (${result.reasons.join("; ")})`
                : "")
          : `Error: ${result.error}`,
      );
    });
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Flame className="size-5 text-orange-500" />
            <h1 className="text-xl font-bold">Email Warmup</h1>
            <div className="flex items-center gap-1.5">
              {statusIcon}
              <span className={`text-sm font-medium capitalize ${statusColor}`}>
                {config.status}
              </span>
            </div>
          </div>
          <p className="text-sm text-neutral-500">
            {config.sending_email} · Day {config.current_day} · {phase}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {config.status === "active" ? (
            <Button
              variant="secondary"
              onClick={handlePause}
              disabled={isPending}
              className="gap-1.5"
            >
              <Pause className="size-3.5" />
              Pause
            </Button>
          ) : config.status === "paused" ? (
            <Button
              variant="secondary"
              onClick={handleResume}
              disabled={isPending}
              className="gap-1.5"
            >
              <Play className="size-3.5" />
              Resume
            </Button>
          ) : null}
          {rewarming ? (
            <Button
              variant="secondary"
              onClick={handleStopRewarm}
              disabled={isPending}
              className="gap-1.5"
              title="Stop re-warming and return to the maintenance schedule"
            >
              <Flame className="size-3.5 text-amber-500" />
              Stop re-warm
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={handleRewarm}
              disabled={isPending}
              className="gap-1.5"
              title="Pull the domain off the maintenance floor into a gentle re-warm ramp"
            >
              <Flame className="size-3.5 text-orange-500" />
              Re-warm now
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={handleManualTick}
            disabled={isPending}
            className="gap-1.5"
            title="Manually trigger one engine tick"
          >
            <RefreshCw className={`size-3.5 ${isPending ? "animate-spin" : ""}`} />
            Run now
          </Button>
        </div>
      </div>

      {message && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-md px-3 py-2">
          {message}
        </p>
      )}

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((alert, i) => (
            <div
              key={i}
              className={`flex items-start gap-2.5 rounded-md px-3 py-2.5 text-sm ${
                alert.level === "critical"
                  ? "bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50 text-red-800 dark:text-red-300"
                  : "bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200 dark:border-yellow-900/50 text-yellow-800 dark:text-yellow-300"
              }`}
            >
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <span>{alert.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <Mail className="size-4 text-neutral-400" />
            <span className="text-xs text-neutral-500">Sent today</span>
          </div>
          <p className="text-2xl font-bold">
            {sentToday}
            <span className="text-base font-normal text-neutral-400">
              /{targetToday}
            </span>
          </p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="size-4 text-neutral-400" />
            <span className="text-xs text-neutral-500">Total sent</span>
          </div>
          <p className="text-2xl font-bold">{totalSent}</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <Inbox className="size-4 text-neutral-400" />
            <span className="text-xs text-neutral-500">Inbox rate</span>
          </div>
          {inboxPct !== null ? (
            <div className="flex items-center gap-3 mt-1">
              <RingGauge pct={inboxPct} color={inboxColor} />
              <span className="text-[11px] text-neutral-400 leading-tight whitespace-pre-line">
                {hasImapRate ? "Inbox vs spam\n(seed mail)" : "DMARC-authenticated\ndelivery"}
              </span>
            </div>
          ) : (
            <p className="text-sm text-neutral-400 mt-1">Not enough data</p>
          )}
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <Shield className="size-4 text-neutral-400" />
            <span className="text-xs text-neutral-500">Domain rep</span>
          </div>
          {hasPostmasterRep ? (
            <p className="text-2xl font-bold">
              <ReputationBadge value={postmasterRep} />
            </p>
          ) : derivedHealth ? (
            <div className="mt-1 space-y-1.5">
              <div className="flex items-center gap-2">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: derivedHealth.color }}
                  aria-hidden
                />
                <span
                  className="text-xl font-bold leading-none"
                  style={{ color: derivedHealth.color }}
                >
                  {derivedHealth.grade}
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.round(derivedHealth.score * 100)}%`,
                    backgroundColor: derivedHealth.color,
                  }}
                />
              </div>
              <span className="text-[10px] text-neutral-400">{derivedHealth.basis}</span>
            </div>
          ) : (
            <p className="text-2xl font-bold">
              <ReputationBadge value={null} />
            </p>
          )}
        </Card>
      </div>

      {/* Body: log + health */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Recent activity log */}
        <Card className="p-4">
          <h2 className="font-semibold text-sm mb-3">Recent Activity</h2>
          {recentLog.length === 0 ? (
            <p className="text-sm text-neutral-400 py-4 text-center">
              No emails sent yet.
            </p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              {recentLog.slice(0, 30).map((entry) => (
                <LogRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </Card>

        {/* Domain health */}
        <Card className="p-4 space-y-4">
          <h2 className="font-semibold text-sm">Deliverability Health</h2>

          {/* Inbox gauge */}
          <InboxRateGauge rate={spamAnalysis.inboxRate} />

          {/* Live DNS checks — work from email #1, unlike Postmaster */}
          {deliverability ? (
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-400">
                  Auth &amp; reputation (live DNS)
                </span>
                <span className="text-[10px] text-neutral-500">{deliverability.domain}</span>
              </div>
              <CheckRow label="SPF" check={deliverability.spf} />
              <CheckRow label="DKIM" check={deliverability.dkim} />
              <CheckRow label="DMARC" check={deliverability.dmarc} />
              <CheckRow label="Blocklist" check={deliverability.blocklist} />
            </div>
          ) : null}

          {/* DMARC aggregate reports — in-house ingestion, works at low volume */}
          {dmarc ? <DmarcPanel dmarc={dmarc} /> : null}

          {latestHealth ? (
            <div className="space-y-3">
              {/* Auth ratios */}
              {(
                [
                  ["SPF pass rate", latestHealth.spf_success_ratio],
                  ["DKIM pass rate", latestHealth.dkim_success_ratio],
                  ["DMARC pass rate", latestHealth.dmarc_success_ratio],
                  ["Encrypted inbound", latestHealth.inbound_encryption_ratio],
                ] as [string, number | null][]
              ).map(([label, val]) => {
                if (val === null) return null;
                const pct = Math.round(val * 100);
                const color =
                  pct >= 95
                    ? "bg-green-500"
                    : pct >= 80
                      ? "bg-yellow-500"
                      : "bg-red-500";
                return (
                  <div key={label} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-neutral-500">{label}</span>
                      <span className="font-medium">{pct}%</span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${color}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}

              {/* Spam rate */}
              {latestHealth.spam_rate !== null && (
                <div className="pt-1 border-t border-neutral-100 dark:border-neutral-800">
                  <div className="flex justify-between text-xs">
                    <span className="text-neutral-500">
                      User-reported spam rate
                    </span>
                    <span
                      className={`font-semibold ${
                        (latestHealth.spam_rate ?? 0) > 0.05
                          ? "text-red-500"
                          : "text-green-600"
                      }`}
                    >
                      {((latestHealth.spam_rate ?? 0) * 100).toFixed(2)}%
                    </span>
                  </div>
                </div>
              )}

              <p className="text-xs text-neutral-400">
                Last updated:{" "}
                {new Date(latestHealth.recorded_date).toLocaleDateString([], {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            </div>
          ) : (
            <div className="py-4 text-center">
              <Shield className="size-8 mx-auto mb-2 text-neutral-200 dark:text-neutral-700" />
              <p className="text-sm text-neutral-400">
                No Postmaster data yet.
              </p>
              <p className="text-xs text-neutral-400 mt-1">
                Google needs ~100 emails/day to Gmail before data appears.
                Expected around Week 4 (Day 22+).
              </p>
            </div>
          )}
        </Card>
      </div>

      {/* Ramp progress */}
      <Card className="p-4">
        <h2 className="font-semibold text-sm mb-3">Ramp Schedule</h2>
        <div className="flex gap-2 flex-wrap">
          {[
            ...RAMP_SCHEDULE.map((w, i) => ({
              label: `Week ${i + 1}`,
              target: w.dailyTarget,
              days: `${w.weekStart}–${w.weekEnd}`,
              weekStart: w.weekStart,
              weekEnd: w.weekEnd,
              isMaintenance: false,
            })),
            {
              label: "Maintenance",
              target: MAINTENANCE_DAILY_TARGET,
              days: `${(RAMP_SCHEDULE[RAMP_SCHEDULE.length - 1]?.weekEnd ?? 28) + 1}+`,
              weekStart: (RAMP_SCHEDULE[RAMP_SCHEDULE.length - 1]?.weekEnd ?? 28) + 1,
              weekEnd: 9999,
              isMaintenance: true,
            },
          ].map((week) => {
            const dayStart = week.weekStart;
            const dayEnd = week.weekEnd;
            const isActive = config.current_day >= dayStart && config.current_day <= dayEnd;
            const isPast = !week.isMaintenance && config.current_day > dayEnd;

            return (
              <div
                key={week.label}
                className={`rounded-md px-3 py-2 text-center min-w-[90px] border ${
                  isActive
                    ? "border-orange-300 bg-orange-50 dark:bg-orange-950/30 dark:border-orange-800"
                    : isPast
                      ? "border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900/50"
                      : "border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50"
                }`}
              >
                <p
                  className={`text-xs font-semibold ${
                    isActive
                      ? "text-orange-700 dark:text-orange-300"
                      : isPast
                        ? "text-green-700 dark:text-green-400"
                        : "text-neutral-500"
                  }`}
                >
                  {week.label}
                </p>
                <p
                  className={`text-lg font-bold ${
                    isActive
                      ? "text-orange-600 dark:text-orange-400"
                      : isPast
                        ? "text-green-600 dark:text-green-500"
                        : "text-neutral-400"
                  }`}
                >
                  {week.target}
                </p>
                <p className="text-xs text-neutral-400">/day · days {week.days}</p>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Pause reason */}
      {config.status === "paused" && config.pause_reason && (
        <div className="rounded-md bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-900/40 px-4 py-3 text-sm">
          <span className="font-semibold text-orange-800 dark:text-orange-300">
            Paused:{" "}
          </span>
          <span className="text-orange-700 dark:text-orange-400">
            {config.pause_reason}
          </span>
        </div>
      )}

      {rewarming && (
        <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 px-4 py-3 text-sm">
          <span className="font-semibold text-amber-800 dark:text-amber-300">
            Re-warming ({targetToday}/day):{" "}
          </span>
          <span className="text-amber-700 dark:text-amber-400">
            {config.rewarm_reason ?? "deliverability dip detected"} · climbing back
            to full volume, then settles to maintenance once inbox placement recovers.
          </span>
        </div>
      )}
    </div>
  );
}
