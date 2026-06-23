"use client";

import {
  CheckCircle2,
  Loader2,
  Lock,
  Play,
  Plus,
  Upload,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import {
  SOURCE_META,
  CRAWLABLE_SOURCES,
  type DiscoverySource,
  type CrawlableSource,
} from "@/lib/discover/source-meta";
import type { DiscoveryRun } from "@/lib/discover/runs-queries";
import { cn, relativeTime } from "@/lib/utils";
import { closeStuckRuns } from "@/lib/discover/crawl-action";
import { CsvUploadDrawer } from "./csv-upload-drawer";
import { CrawlDrawer } from "./crawl-drawer";
import { RunAllModal } from "./run-all-modal";

interface DiscoverPageProps {
  runs: DiscoveryRun[];
  icps: {
    id: string;
    name: string;
    market: "CA" | "MX" | "US" | "LATAM";
    search_keywords: string[];
    geo_regions: string[];
  }[];
  canManage: boolean;
  /** Server-resolved: which crawl sources have their API key set */
  availableCrawlSources: CrawlableSource[];
}

const STATUS_TONE: Record<string, "success" | "info" | "danger" | "neutral"> = {
  complete: "success",
  running: "info",
  pending: "info",
  failed: "danger",
};

export function DiscoverPage({
  runs,
  icps,
  canManage,
  availableCrawlSources,
}: DiscoverPageProps) {
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [crawlSource, setCrawlSource] = React.useState<CrawlableSource | null>(null);
  const [runAllOpen, setRunAllOpen] = React.useState(false);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border-subtle)] px-4">
        <span className="font-mono text-xs text-[var(--color-fg-500)]">/discover</span>
        <span className="text-[11px] text-[var(--color-fg-500)]">
          {runs.length} run{runs.length === 1 ? "" : "s"} · {icps.length} ICP
          {icps.length === 1 ? "" : "s"}
        </span>
        {canManage ? (
          <div className="ml-auto flex items-center gap-2">
            {availableCrawlSources.length > 0 && icps.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={() => setRunAllOpen(true)}
              >
                <Play className="h-3.5 w-3.5" aria-hidden /> Run All Sources
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setUploadOpen(true)}
            >
              <Upload className="h-3.5 w-3.5" aria-hidden /> Upload CSV
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-8 overflow-y-auto p-4">
        <SourcesSection
          onCsvClick={canManage ? () => setUploadOpen(true) : undefined}
          onCrawlClick={canManage ? (src) => setCrawlSource(src) : undefined}
          availableCrawlSources={availableCrawlSources}
          canManage={canManage}
        />
        <RunHistorySection runs={runs} canManage={canManage} />
      </div>

      <CsvUploadDrawer open={uploadOpen} onOpenChange={setUploadOpen} icps={icps} />

      <RunAllModal
        open={runAllOpen}
        onOpenChange={setRunAllOpen}
        icps={icps}
      />

      {crawlSource && (
        <CrawlDrawer
          open={crawlSource !== null}
          onOpenChange={(o) => !o && setCrawlSource(null)}
          source={crawlSource}
          icps={icps}
        />
      )}
    </div>
  );
}

function SourcesSection({
  onCsvClick,
  onCrawlClick,
  availableCrawlSources,
  canManage,
}: {
  onCsvClick: (() => void) | undefined;
  onCrawlClick: ((src: CrawlableSource) => void) | undefined;
  availableCrawlSources: CrawlableSource[];
  canManage: boolean;
}) {
  const sources = (Object.keys(SOURCE_META) as DiscoverySource[]).map((s) => ({
    key: s,
    ...SOURCE_META[s],
  }));

  // Mark crawl sources as available if their key is set at runtime
  const effectiveAvailable = (key: DiscoverySource): boolean => {
    if (key === "yellowpages_ca") return true; // no key needed
    if ((CRAWLABLE_SOURCES as readonly string[]).includes(key)) {
      return availableCrawlSources.includes(key as CrawlableSource);
    }
    return SOURCE_META[key].available;
  };

  const getAction = (key: DiscoverySource): (() => void) | undefined => {
    if (key === "manual_upload") return onCsvClick;
    if ((CRAWLABLE_SOURCES as readonly string[]).includes(key)) {
      return effectiveAvailable(key) && onCrawlClick
        ? () => onCrawlClick(key as CrawlableSource)
        : undefined;
    }
    return undefined;
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
          Discovery sources
        </h2>
        <p className="text-xs text-[var(--color-fg-500)]">
          Yellow Pages CA and manual upload work today. The rest unlock as credentials land.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {sources.map((s) => {
          const avail = effectiveAvailable(s.key);
          return (
            <SourceCard
              key={s.key}
              label={s.label}
              description={s.description}
              available={avail}
              blockedOn={avail ? null : s.blockedOn}
              actionLabel={s.key === "manual_upload" ? "Upload CSV" : "Run discovery"}
              actionIcon={s.key === "manual_upload" ? Upload : Plus}
              onAction={getAction(s.key)}
              actionDisabled={!avail || !canManage}
            />
          );
        })}
      </div>
    </section>
  );
}

function SourceCard({
  label,
  description,
  available,
  blockedOn,
  actionLabel,
  actionIcon: ActionIcon,
  onAction,
  actionDisabled,
}: {
  label: string;
  description: string;
  available: boolean;
  blockedOn: string | null;
  actionLabel: string;
  actionIcon: LucideIcon;
  onAction: (() => void) | undefined;
  actionDisabled: boolean;
}) {
  return (
    <Card
      className={cn(
        "transition-[opacity,box-shadow]",
        !available && "opacity-50",
        available && "hover:ring-[var(--color-border-strong)]",
      )}
    >
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col">
            <span
              className={cn(
                "truncate text-sm font-medium",
                available ? "text-[var(--color-fg-50)]" : "text-[var(--color-fg-300)]",
              )}
            >
              {label}
            </span>
            <p className="mt-0.5 text-[11px] text-[var(--color-fg-500)]">{description}</p>
          </div>
          {available ? (
            <Chip tone="success" className="shrink-0 gap-1">
              <CheckCircle2 className="h-3 w-3" aria-hidden /> ready
            </Chip>
          ) : (
            <Chip tone="neutral" className="shrink-0 gap-1">
              <Lock className="h-3 w-3" aria-hidden /> blocked
            </Chip>
          )}
        </div>
        {blockedOn ? (
          <p className="text-[11px] italic text-[var(--color-fg-700)]">{blockedOn}</p>
        ) : null}
        <div className="mt-auto pt-1">
          {/* Ready sources get a primary button — it's the most important action on this card */}
          <Button
            type="button"
            size="sm"
            variant={available && !actionDisabled ? "primary" : "secondary"}
            disabled={actionDisabled}
            onClick={onAction}
          >
            <ActionIcon className="h-3.5 w-3.5" aria-hidden /> {actionLabel}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RunHistorySection({ runs, canManage }: { runs: DiscoveryRun[]; canManage: boolean }) {
  const [closing, startClosing] = React.useTransition();
  const stuckCount = runs.filter((r) => r.status === "running").length;

  const handleCloseStuck = () => {
    startClosing(async () => {
      await closeStuckRuns();
    });
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
            Run history
          </h2>
          <p className="text-xs text-[var(--color-fg-500)]">
            Every discovery run — manual or automated — is logged here.
          </p>
        </div>
        {canManage && stuckCount > 0 && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={handleCloseStuck}
            disabled={closing}
            title="Close runs stuck in 'running' for more than 15 minutes"
          >
            {closing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <XCircle className="h-3.5 w-3.5" aria-hidden />
            )}
            {closing ? "Closing…" : `Close ${stuckCount} stuck run${stuckCount === 1 ? "" : "s"}`}
          </Button>
        )}
      </div>
      {runs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          description="Upload a CSV above to seed your first batch of prospects, or wait for a scheduled run once credentials land."
        />
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-lg)] bg-[var(--color-bg-800)] ring-1 ring-inset ring-[var(--color-border-default)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-900)] text-[10px] uppercase tracking-wider text-[var(--color-fg-700)]">
              <tr>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">ICP</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">New / Duplicate</th>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Triggered by</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const tone = STATUS_TONE[r.status] ?? "neutral";
                const StatusIcon = r.status === "complete" ? CheckCircle2 : r.status === "failed" ? XCircle : null;
                return (
                  <tr key={r.id} className="border-b border-[var(--color-border-subtle)] last:border-b-0">
                    <td className="px-3 py-2 text-[var(--color-fg-300)]">
                      {SOURCE_META[r.source]?.label ?? r.source}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-[var(--color-fg-500)]">
                      {r.icp_name ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Chip tone={tone} className="gap-1">
                        {StatusIcon ? <StatusIcon className="h-3 w-3" aria-hidden /> : null}
                        {r.status}
                      </Chip>
                      {r.error_message ? (
                        <div className="mt-0.5 truncate text-[10px] italic text-[var(--color-danger-300)]">
                          {r.error_message}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-[var(--color-fg-300)]">
                      <span className="text-[var(--color-success-300)]">+{r.candidates_new}</span>
                      {" / "}
                      <span className="text-[var(--color-fg-500)]">{r.candidates_duplicate} filtered</span>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-[var(--color-fg-500)]">
                      {r.started_at ? relativeTime(r.started_at) : "—"}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-[var(--color-fg-500)]">
                      {r.triggered_by_name ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
