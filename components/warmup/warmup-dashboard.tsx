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
import { Chip } from "@/components/ui/chip";
import type {
  WarmupConfig,
  WarmupLogEntry,
  DomainHealth,
} from "@/lib/warmup/types";
import { getRampPhase, getDailyTarget } from "@/lib/warmup/types";
import { analyzeSpamRate, buildAlerts } from "@/lib/warmup/intelligence";
import { pauseWarmup, resumeWarmup, triggerEngineManually } from "./warmup-actions";

// ── Props ──────────────────────────────────────────────────────────────────────

type Props = {
  config: WarmupConfig | null;
  recentLog: WarmupLogEntry[];
  healthHistory: DomainHealth[];
  latestHealth: DomainHealth | null;
};

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
  healthHistory,
  latestHealth,
}: Props) {
  const [isPending, startTransition] = React.useTransition();
  const [message, setMessage] = React.useState<string | null>(null);

  // Spam analysis from log
  const spamAnalysis = analyzeSpamRate(recentLog);

  // Alerts
  const alerts = config
    ? buildAlerts(config, spamAnalysis, latestHealth)
    : [];

  // Stats
  const sentToday = config?.emails_sent_today ?? 0;
  const targetToday = config ? getDailyTarget(config.current_day) : 5;
  const phase = config ? getRampPhase(config.current_day) : "—";

  // Total sent this week from log
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const sentThisWeek = recentLog.filter(
    (l) =>
      l.direction === "sent" && new Date(l.created_at).getTime() > weekAgo,
  ).length;

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

  function handleManualTick() {
    startTransition(async () => {
      setMessage(null);
      const result = await triggerEngineManually();
      setMessage(
        result.ok
          ? `Engine tick complete — sent ${result.sent ?? 0} email(s).`
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
            <span className="text-xs text-neutral-500">Sent this week</span>
          </div>
          <p className="text-2xl font-bold">{sentThisWeek}</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <Inbox className="size-4 text-neutral-400" />
            <span className="text-xs text-neutral-500">Inbox rate</span>
          </div>
          {spamAnalysis.inboxRate !== null ? (
            <p className="text-2xl font-bold">
              {Math.round(spamAnalysis.inboxRate * 100)}%
            </p>
          ) : (
            <p className="text-sm text-neutral-400 mt-1">Not enough data</p>
          )}
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <Shield className="size-4 text-neutral-400" />
            <span className="text-xs text-neutral-500">Domain rep</span>
          </div>
          <p className="text-2xl font-bold">
            <ReputationBadge value={latestHealth?.domain_reputation ?? null} />
          </p>
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
                Add the{" "}
                <code className="bg-neutral-100 dark:bg-neutral-800 px-1 py-0.5 rounded text-xs">
                  postmaster.readonly
                </code>{" "}
                scope to your Gmail connection and reconnect.
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
            { label: "Week 1", target: 5, days: "1–7" },
            { label: "Week 2", target: 10, days: "8–14" },
            { label: "Week 3", target: 20, days: "15–21" },
            { label: "Week 4", target: 40, days: "22–28" },
            { label: "Maintenance", target: 5, days: "29+" },
          ].map((week) => {
            const dayParts = week.days.split("–");
            const dayStart = parseInt(dayParts[0] ?? "99");
            const dayEnd = parseInt(dayParts[1] ?? "0");
            const isActive =
              week.label === "Maintenance"
                ? config.current_day >= 29
                : config.current_day >= dayStart && config.current_day <= dayEnd;
            const isPast =
              week.label !== "Maintenance" &&
              config.current_day > dayEnd;

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
    </div>
  );
}
