"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import type { HunterAnalytics } from "@/lib/hunter/types";
import {
  AlertTriangle,
  BarChart3,
  Globe,
  Sparkles,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";

interface Props {
  analytics: HunterAnalytics;
}

function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-[var(--color-fg-500)]">{label}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight text-[var(--color-fg-50)]">
              {value}
            </p>
            {sub && <p className="mt-0.5 text-xs text-[var(--color-fg-500)]">{sub}</p>}
          </div>
          <div className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-bg-700)] text-[var(--color-fg-300)] ring-1 ring-inset ring-[var(--color-border-default)]">
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BarList({
  items,
  max,
}: {
  items: { label: string; count: number; contacted?: number }[];
  max: number;
}) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.label}>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-[var(--color-fg-300)]">{item.label}</span>
            <span className="text-[var(--color-fg-500)]">
              {item.count}
              {item.contacted !== undefined ? ` · ${item.contacted} contacted` : ""}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg-700)]">
            <div
              className="h-full rounded-full bg-[var(--color-accent-300)]"
              style={{ width: `${Math.round((item.count / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function HunterAnalytics({ analytics }: Props) {
  const conversionRate =
    analytics.totalScans > 0
      ? Math.round((analytics.totalContacted / analytics.totalScans) * 100)
      : 0;

  const industryItems = [...analytics.byIndustry]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((v) => ({ label: v.industry, count: v.count, contacted: v.contacted }));

  const maxIndustry = Math.max(...industryItems.map((v) => v.count), 1);

  const teamSizeItems = [...analytics.byTeamSize]
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((v) => ({ label: v.team_size, count: v.count }));

  const maxTeamSize = Math.max(...teamSizeItems.map((v) => v.count), 1);

  const timesinkItems = [...analytics.byTimesink]
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((v) => ({ label: v.timesink, count: v.count }));

  const maxTimesink = Math.max(...timesinkItems.map((v) => v.count), 1);

  const signalGapItems = [
    { label: "No Meta Pixel", pct: analytics.signalGaps.noMetaPixel },
    { label: "No Analytics", pct: analytics.signalGaps.noAnalytics },
    { label: "No Email Capture", pct: analytics.signalGaps.noEmailCapture },
    { label: "Not reachable", pct: analytics.signalGaps.notReachable },
  ].filter((g) => g.pct > 0);

  const cadFormatted = new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  });
  const mxnFormatted = new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    maximumFractionDigits: 0,
  });

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Total Scans"
          value={analytics.totalScans}
          icon={<BarChart3 className="size-4" />}
        />
        <StatCard
          label="This Week"
          value={analytics.scansThisWeek}
          icon={<TrendingUp className="size-4" />}
        />
        <StatCard
          label="Conversion Rate"
          value={`${conversionRate}%`}
          sub={`${analytics.totalContacted} contacted`}
          icon={<Zap className="size-4" />}
        />
        <StatCard
          label="With Website"
          value={analytics.withWebsite}
          sub={`${analytics.withoutWebsite} without`}
          icon={<Globe className="size-4" />}
        />
      </div>

      {/* Funnel */}
      <Card>
        <CardContent className="pt-4">
          <p className="mb-3 text-xs font-medium text-[var(--color-fg-500)] uppercase tracking-wider">
            Pipeline Funnel
          </p>
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center justify-between text-xs text-[var(--color-fg-300)] mb-1">
                <span>{analytics.totalScans} scanned</span>
                <span>
                  {analytics.totalContacted} contacted ({conversionRate}%)
                </span>
              </div>
              <div className="relative h-3 w-full overflow-hidden rounded-full bg-[var(--color-bg-700)]">
                <div
                  className="h-full rounded-full bg-[var(--color-accent-300)] transition-all"
                  style={{ width: `${conversionRate}%` }}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 3-column breakdowns */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* By Industry */}
        <Card>
          <CardContent className="pt-4">
            <div className="mb-3 flex items-center gap-2">
              <Users className="size-4 text-[var(--color-fg-500)]" />
              <p className="text-xs font-medium text-[var(--color-fg-300)]">By Industry</p>
            </div>
            <BarList items={industryItems} max={maxIndustry} />
          </CardContent>
        </Card>

        {/* By Team Size + Time Sink */}
        <Card>
          <CardContent className="pt-4 space-y-5">
            <div>
              <div className="mb-3 flex items-center gap-2">
                <Users className="size-4 text-[var(--color-fg-500)]" />
                <p className="text-xs font-medium text-[var(--color-fg-300)]">By Team Size</p>
              </div>
              <BarList items={teamSizeItems} max={maxTeamSize} />
            </div>
            <div>
              <div className="mb-3 flex items-center gap-2">
                <Zap className="size-4 text-[var(--color-fg-500)]" />
                <p className="text-xs font-medium text-[var(--color-fg-300)]">By Time Sink</p>
              </div>
              <BarList items={timesinkItems} max={maxTimesink} />
            </div>
          </CardContent>
        </Card>

        {/* Top Inefficiencies */}
        <Card>
          <CardContent className="pt-4">
            <div className="mb-3 flex items-center gap-2">
              <Sparkles className="size-4 text-[var(--color-fg-500)]" />
              <p className="text-xs font-medium text-[var(--color-fg-300)]">Top Inefficiencies</p>
            </div>
            {analytics.topFindings.length === 0 ? (
              <p className="text-xs text-[var(--color-fg-500)]">No findings yet.</p>
            ) : (
              <ul className="space-y-2">
                {analytics.topFindings.slice(0, 8).map((f) => (
                  <li key={f.title} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs text-[var(--color-fg-300)]">
                      {f.title}
                    </span>
                    <Chip tone="accent" className="shrink-0">
                      {f.count}×
                    </Chip>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Signal Gaps */}
      {signalGapItems.length > 0 && (
        <Card>
          <CardContent className="pt-4">
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle className="size-4 text-[var(--color-warning-300)]" />
              <p className="text-xs font-medium text-[var(--color-fg-300)]">Signal Gaps</p>
              <span className="text-xs text-[var(--color-fg-500)]">
                — common weaknesses across scanned leads
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {signalGapItems.map((g) => (
                <Chip key={g.label} tone="warning">
                  {g.label}: {g.pct}%
                </Chip>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Value row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-[var(--color-fg-500)] mb-2">Pipeline Value — 🇨🇦 CAD</p>
            <p className="text-2xl font-semibold tracking-tight text-[var(--color-fg-50)]">
              {cadFormatted.format(analytics.totalValueCAD)}
            </p>
            <p className="mt-1 text-xs text-[var(--color-fg-500)]">
              avg {cadFormatted.format(analytics.avgValueCAD)} per lead
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-[var(--color-fg-500)] mb-2">Pipeline Value — 🇲🇽 MXN</p>
            <p className="text-2xl font-semibold tracking-tight text-[var(--color-fg-50)]">
              {mxnFormatted.format(analytics.totalValueMXN)}
            </p>
            <p className="mt-1 text-xs text-[var(--color-fg-500)]">
              avg {mxnFormatted.format(analytics.avgValueMXN)} per lead
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
