"use client";

/**
 * RunAllModal — multi-step "Run All Sources + Auto-Pipeline" flow.
 *
 * Step 1: Pick ICP → preview queries
 * Step 2: Discovery running (YP + Brave)
 * Step 3: Pipeline running (per-prospect scrape → research → score → triage)
 * Step 4: Summary
 */

import {
  CheckCircle2,
  Globe,
  Loader2,
  Play,
  ShieldOff,
  Sparkles,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Select } from "@/components/ui/select";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
} from "@/components/ui/drawer";
import { runAllSources, previewRunAllSources, type RunAllPreview } from "@/lib/discover/run-all-action";
import { getProspectIdsForRuns, getRawProspectIds, processSingleProspect, pruneRunToTop30, type SinglePipelineResult } from "@/lib/discover/pipeline-action";

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = "pick" | "discovering" | "pipeline" | "done";

interface RunAllModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icps: { id: string; name: string; market: string }[];
}

// ── Component ─────────────────────────────────────────────────────────────────

export function RunAllModal({ open, onOpenChange, icps }: RunAllModalProps) {
  const [step, setStep] = React.useState<Step>("pick");
  const [selectedIcpId, setSelectedIcpId] = React.useState<string>(icps[0]?.id ?? "");
  const [preview, setPreview] = React.useState<RunAllPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingRawCount, setPendingRawCount] = React.useState(0);
  const [prunedStats, setPrunedStats] = React.useState<{ kept: number; deleted: number } | null>(null);

  // Discovery results
  const [discoverStats, setDiscoverStats] = React.useState<{
    new: number;
    dup: number;
    errors: string[];
    partial?: boolean; // true when discovery timed out but some prospects were still inserted
  } | null>(null);

  // Pipeline results
  const [pipelineResults, setPipelineResults] = React.useState<SinglePipelineResult[]>([]);
  const [pipelineTotal, setPipelineTotal] = React.useState(0);

  // Only initialise ICP selection on first open — never reset mid-run or after done
  React.useEffect(() => {
    if (open && !selectedIcpId) {
      setSelectedIcpId(icps[0]?.id ?? "");
    }
  }, [open, icps, selectedIcpId]);

  // Load preview + raw count when ICP changes (pick step only)
  React.useEffect(() => {
    if (!selectedIcpId || step !== "pick") return;
    setLoadingPreview(true);
    setPendingRawCount(0);
    Promise.all([
      previewRunAllSources(selectedIcpId).then(setPreview),
      getRawProspectIds(selectedIcpId).then((r) => setPendingRawCount(r.ok ? r.ids.length : 0)),
    ]).finally(() => setLoadingPreview(false));
  }, [selectedIcpId, step]);

  // Process only pending raw prospects without re-running discovery
  const handleProcessPending = async () => {
    if (!selectedIcpId) return;
    setError(null);
    setDiscoverStats(null);
    setPipelineResults([]);
    setPipelineTotal(0);
    setStep("pipeline");

    const rawResult = await getRawProspectIds(selectedIcpId);
    if (!rawResult.ok || rawResult.ids.length === 0) {
      setStep("done");
      return;
    }

    const PIPELINE_CAP = 50;
    const idsToProcess = rawResult.ids.slice(0, PIPELINE_CAP);
    setPipelineTotal(idsToProcess.length);

    const BATCH = 5;
    for (let i = 0; i < idsToProcess.length; i += BATCH) {
      const batch = idsToProcess.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map((id) => processSingleProspect(id)));
      setPipelineResults((prev) => [...prev, ...batchResults]);
    }

    // Prune to top 30: keep the strongest prospects, delete the rest
    const pruneResult = await pruneRunToTop30(idsToProcess);
    if (pruneResult.ok && pruneResult.deleted > 0) {
      setPrunedStats({ kept: pruneResult.kept, deleted: pruneResult.deleted });
    }

    setStep("done");
  };

  // Reset everything and go back to pick (used by "Run Again" button)
  const handleReset = () => {
    setStep("pick");
    setPreview(null);
    setError(null);
    setDiscoverStats(null);
    setPipelineResults([]);
    setPipelineTotal(0);
    setPrunedStats(null);
  };

  const handleRun = async () => {
    if (!selectedIcpId) return;
    // Reset run-specific state but keep ICP selection
    setError(null);
    setDiscoverStats(null);
    setPipelineResults([]);
    setPipelineTotal(0);
    setStep("discovering");

    // Step 1: Run all crawl sources
    // NOTE: This can 504 on large runs (many keywords × sources).
    // Even on timeout, prospects are often inserted server-side before the
    // response is cut. We fall back to getRawProspectIds so the pipeline
    // still runs on anything that was actually inserted.
    let prospectIds: string[] = [];
    const discoverResult = await runAllSources(selectedIcpId);

    if (!discoverResult.ok) {
      // Discovery errored or timed out — check if any raw prospects were
      // inserted anyway (common on 504: server kept running after client timeout).
      const rawResult = await getRawProspectIds(selectedIcpId);
      if (!rawResult.ok || rawResult.ids.length === 0) {
        // Nothing was inserted — surface the error
        setError(discoverResult.error);
        setStep("pick");
        return;
      }
      // Some prospects were inserted — run the pipeline on those
      prospectIds = rawResult.ids;
      setDiscoverStats({
        new: rawResult.ids.length,
        dup: 0,
        errors: [discoverResult.error],
        partial: true,
      });
    } else {
      setDiscoverStats({
        new: discoverResult.candidatesNew,
        dup: discoverResult.candidatesDuplicate,
        errors: discoverResult.errors,
      });

      if (discoverResult.candidatesNew === 0) {
        setStep("done");
        return;
      }

      // Step 2: Get new prospect IDs from the completed run
      const idsResult = await getProspectIdsForRuns(discoverResult.runIds);
      prospectIds = idsResult.ok ? idsResult.ids : [];

      // If run-based lookup returned nothing, fall back to raw query
      // (can happen if all prospects were already processed in a prior attempt)
      if (prospectIds.length === 0) {
        const rawResult = await getRawProspectIds(selectedIcpId);
        prospectIds = rawResult.ok ? rawResult.ids : [];
      }
    }

    if (prospectIds.length === 0) {
      setStep("done");
      return;
    }

    // Cap pipeline at 50 prospects per run — discovery stores all finds,
    // but we only scrape/score/triage this many to keep runs fast + cheap.
    const PIPELINE_CAP = 50;
    const idsToProcess = prospectIds.slice(0, PIPELINE_CAP);

    setPipelineTotal(idsToProcess.length);
    setStep("pipeline");

    // Step 3: Process in batches of 5
    const BATCH = 5;
    for (let i = 0; i < idsToProcess.length; i += BATCH) {
      const batch = idsToProcess.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map((id) => processSingleProspect(id)));
      setPipelineResults((prev) => [...prev, ...batchResults]);
    }

    // Step 4: Prune to top 30 — keep the strongest, delete the rest
    const pruneResult = await pruneRunToTop30(idsToProcess);
    if (pruneResult.ok && pruneResult.deleted > 0) {
      setPrunedStats({ kept: pruneResult.kept, deleted: pruneResult.deleted });
    }

    setStep("done");
  };

  const activeIcp = icps.find((i) => i.id === selectedIcpId);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerPortal>
        <DrawerOverlay />
        <DrawerContent className="w-full max-w-md">
          <DrawerHeader>
            <DrawerTitle className="flex items-center gap-2">
              <Play className="h-4 w-4 text-[var(--color-primary-400)]" aria-hidden />
              Run All Sources
            </DrawerTitle>
          </DrawerHeader>

          <DrawerBody className="flex flex-col gap-4">
            {step === "pick" && (
              <PickStep
                icps={icps}
                selectedIcpId={selectedIcpId}
                onSelectIcp={setSelectedIcpId}
                preview={preview}
                loadingPreview={loadingPreview}
                error={error}
                pendingRawCount={pendingRawCount}
                onProcessPending={handleProcessPending}
              />
            )}
            {step === "discovering" && <DiscoveringStep stats={discoverStats} />}
            {step === "pipeline" && (
              <PipelineStep
                results={pipelineResults}
                total={pipelineTotal}
              />
            )}
            {step === "done" && (
              <DoneStep
                discoverStats={discoverStats}
                results={pipelineResults}
                prunedStats={prunedStats}
              />
            )}
          </DrawerBody>

          <DrawerFooter>
            {step === "pick" && (
              <>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={!selectedIcpId || loadingPreview}
                  onClick={handleRun}
                >
                  <Play className="h-3.5 w-3.5" aria-hidden />
                  {activeIcp ? `Run for ${activeIcp.name}` : "Run"}
                </Button>
              </>
            )}
            {(step === "discovering" || step === "pipeline") && (
              <Button variant="ghost" disabled>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Running…
              </Button>
            )}
            {step === "done" && (
              <>
                <Button variant="ghost" onClick={handleReset}>
                  <Play className="h-3.5 w-3.5" aria-hidden />
                  Run Again
                </Button>
                <Button variant="primary" onClick={() => onOpenChange(false)}>
                  Done
                </Button>
              </>
            )}
          </DrawerFooter>
        </DrawerContent>
      </DrawerPortal>
    </Drawer>
  );
}

// ── Step subcomponents ────────────────────────────────────────────────────────

function PickStep({
  icps,
  selectedIcpId,
  onSelectIcp,
  preview,
  loadingPreview,
  error,
  pendingRawCount,
  onProcessPending,
}: {
  icps: { id: string; name: string; market: string }[];
  selectedIcpId: string;
  onSelectIcp: (id: string) => void;
  preview: RunAllPreview | null;
  loadingPreview: boolean;
  error: string | null;
  pendingRawCount: number;
  onProcessPending: () => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-[var(--color-fg-300)]">
          Run for ICP
        </label>
        <Select
          value={selectedIcpId}
          onChange={(e) => onSelectIcp(e.target.value)}
          className="w-full"
        >
          {icps.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
      </div>

      {loadingPreview && (
        <p className="text-xs text-[var(--color-fg-500)] flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading preview…
        </p>
      )}

      {preview && !loadingPreview && (
        <div className="rounded-[var(--radius-md)] bg-[var(--color-bg-900)] p-3 text-xs text-[var(--color-fg-400)] space-y-2 ring-1 ring-inset ring-[var(--color-border-subtle)]">
          {/* Category keywords that will be searched */}
          <div className="space-y-1">
            <p className="font-medium text-[var(--color-fg-200)]">
              Searching {preview.totalDirectoryCrawls} crawls across {preview.directoryKeywords.length} categor{preview.directoryKeywords.length === 1 ? "y" : "ies"}:
            </p>
            <div className="flex flex-wrap gap-1">
              {preview.directoryKeywords.map((kw) => (
                <span
                  key={kw}
                  className="inline-block rounded px-1.5 py-0.5 bg-[var(--color-bg-700)] text-[var(--color-fg-200)] font-mono text-[10px]"
                >
                  {kw}
                </span>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <p className="font-medium text-[var(--color-fg-300)]">Sources:</p>

            {/* CA — Yellow Pages */}
            {(preview.market === "CA" || preview.market === "LATAM") && (
              <p>
                <span className="font-mono text-[var(--color-fg-300)]">YP</span>{" "}
                {preview.directoryKeywords.length} keyword{preview.directoryKeywords.length > 1 ? "s" : ""} in{" "}
                <strong className="text-[var(--color-fg-200)]">{preview.ypLocation}</strong>
              </p>
            )}

            {/* MX — DENUE */}
            {preview.market === "MX" && (
              preview.denueAvailable ? (
                <p>
                  <span className="font-mono text-[var(--color-fg-300)]">DENUE</span>{" "}
                  <strong className="text-[var(--color-fg-200)]">{preview.denueActivity}</strong>
                  {preview.denueState ? (
                    <> in <strong className="text-[var(--color-fg-200)]">{preview.denueState}</strong></>
                  ) : " · all Mexico"}
                </p>
              ) : (
                <p className="text-[var(--color-fg-600)] italic">
                  DENUE not configured (DENUE_API_KEY missing)
                </p>
              )
            )}

            {/* Brave — all markets, once */}
            {preview.braveAvailable ? (
              <p>
                <span className="font-mono text-[var(--color-fg-300)]">Brave</span>{" "}
                <strong className="text-[var(--color-fg-200)]">{preview.braveQuery}</strong>
              </p>
            ) : (
              <p className="text-[var(--color-fg-600)] italic">
                Brave not configured (BRAVE_SEARCH_API_KEY missing)
              </p>
            )}

            {/* Yelp */}
            {preview.yelpAvailable ? (
              <p>
                <span className="font-mono text-[var(--color-fg-300)]">Yelp</span>{" "}
                {preview.directoryKeywords.length} keyword{preview.directoryKeywords.length > 1 ? "s" : ""} in{" "}
                <strong className="text-[var(--color-fg-200)]">{preview.yelpLocation}</strong>
              </p>
            ) : (
              <p className="text-[var(--color-fg-600)] italic">
                Yelp not configured (YELP_API_KEY missing)
              </p>
            )}

            {/* Google Places */}
            {preview.googlePlacesAvailable ? (
              <p>
                <span className="font-mono text-[var(--color-fg-300)]">Google</span>{" "}
                {preview.directoryKeywords.length} keyword{preview.directoryKeywords.length > 1 ? "s" : ""} in{" "}
                <strong className="text-[var(--color-fg-200)]">{preview.googlePlacesLocation}</strong>
              </p>
            ) : (
              <p className="text-[var(--color-fg-600)] italic">
                Google Places not configured (GOOGLE_PLACES_API_KEY missing)
              </p>
            )}
          </div>

          <p className="pt-0.5 text-[var(--color-fg-500)]">
            New prospects will be automatically scraped, researched, scored, and triaged.
          </p>
        </div>
      )}

      {pendingRawCount > 0 && (
        <button
          type="button"
          onClick={onProcessPending}
          className="flex items-center justify-between gap-3 w-full rounded-[var(--radius-md)] px-3 py-2.5 text-xs bg-[var(--color-warning-950)] ring-1 ring-inset ring-[var(--color-warning-800)] text-[var(--color-warning-300)] hover:bg-[var(--color-warning-900)] transition-colors"
        >
          <span className="flex items-center gap-1.5">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {pendingRawCount} raw prospect{pendingRawCount === 1 ? "" : "s"} waiting to be processed
          </span>
          <span className="font-medium underline underline-offset-2 shrink-0">
            Run pipeline →
          </span>
        </button>
      )}

      {error && (
        <p className="text-xs text-[var(--color-danger-300)]">
          <XCircle className="inline-block h-3.5 w-3.5 mr-1" aria-hidden />
          {error}
        </p>
      )}
    </>
  );
}

function DiscoveringStep({ stats }: { stats: { new: number; dup: number; errors: string[]; partial?: boolean } | null }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <Loader2 className="h-6 w-6 animate-spin text-[var(--color-primary-400)]" aria-hidden />
      <p className="text-sm font-medium text-[var(--color-fg-200)]">Running discovery…</p>
      {stats ? (
        <div className="text-center space-y-1">
          <p className="text-xs text-[var(--color-fg-500)]">
            Found{" "}
            <span className="text-[var(--color-success-300)] font-medium">
              +{stats.new} new
            </span>{" "}
            · {stats.dup} duplicates
          </p>
          {stats.partial && (
            <p className="text-xs text-[var(--color-warning-300)]">
              Discovery timed out — running pipeline on inserted prospects
            </p>
          )}
          {!stats.partial && stats.errors.length > 0 && (
            <p className="text-xs text-[var(--color-warning-300)]">{stats.errors.join("; ")}</p>
          )}
        </div>
      ) : (
        <p className="text-xs text-[var(--color-fg-600)]">Querying directories across all categories…</p>
      )}
    </div>
  );
}

const OUTCOME_ICON: Record<string, React.ReactNode> = {
  pitched: <CheckCircle2 className="h-3.5 w-3.5 text-[var(--color-success-300)]" aria-hidden />,
  website_pitch: <Globe className="h-3.5 w-3.5 text-[var(--color-info-300)]" aria-hidden />,
  needs_review: <TriangleAlert className="h-3.5 w-3.5 text-[var(--color-warning-300)]" aria-hidden />,
  suppressed: <ShieldOff className="h-3.5 w-3.5 text-[var(--color-fg-600)]" aria-hidden />,
  error: <XCircle className="h-3.5 w-3.5 text-[var(--color-danger-300)]" aria-hidden />,
};

function PipelineStep({
  results,
  total,
}: {
  results: SinglePipelineResult[];
  total: number;
}) {
  const pct = total > 0 ? Math.round((results.length / total) * 100) : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-xs text-[var(--color-fg-400)]">
        <span className="flex items-center gap-1.5">
          <Sparkles className="h-3 w-3 text-[var(--color-primary-400)]" aria-hidden />
          Running pipeline…
        </span>
        <span>{results.length} / {total}</span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 w-full rounded-full bg-[var(--color-bg-900)] overflow-hidden">
        <div
          className="h-full rounded-full bg-[var(--color-primary-500)] transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Per-prospect results */}
      {results.length > 0 && (
        <div className="max-h-52 overflow-y-auto flex flex-col gap-1">
          {results.map((r) => (
            <div
              key={r.prospect_id}
              className="flex items-center gap-2 text-xs text-[var(--color-fg-400)]"
            >
              {OUTCOME_ICON[r.outcome]}
              <span className="flex-1 truncate">{r.company_name}</span>
              {r.score !== null && (
                <span className="font-mono text-[var(--color-fg-600)]">{r.score}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DoneStep({
  discoverStats,
  results,
  prunedStats,
}: {
  discoverStats: { new: number; dup: number; errors: string[]; partial?: boolean } | null;
  results: SinglePipelineResult[];
  prunedStats: { kept: number; deleted: number } | null;
}) {
  const pitched = results.filter((r) => r.outcome === "pitched").length;
  const websitePitch = results.filter((r) => r.outcome === "website_pitch").length;
  const review = results.filter((r) => r.outcome === "needs_review").length;
  const suppressed = results.filter((r) => r.outcome === "suppressed").length;
  const errors = results.filter((r) => r.outcome === "error").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-[var(--color-success-300)]" aria-hidden />
        <p className="text-sm font-semibold text-[var(--color-fg-100)]">All done</p>
      </div>

      {discoverStats && (
        <div className="text-xs text-[var(--color-fg-400)] space-y-0.5">
          {discoverStats.partial ? (
            <p className="text-[var(--color-warning-300)]">
              Discovery timed out — processed {discoverStats.new} prospects that were already inserted.
              Run again to discover more.
            </p>
          ) : (
            <p>
              Discovered{" "}
              <span className="text-[var(--color-success-300)] font-medium">
                +{discoverStats.new}
              </span>{" "}
              new prospects · {discoverStats.dup} duplicates skipped
            </p>
          )}
          {discoverStats.new > 50 && (
            <p className="text-[var(--color-fg-600)]">
              Processed first 50 — run again to continue with the rest.
            </p>
          )}
        </div>
      )}

      {results.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {pitched > 0 && (
            <Tile
              icon={<CheckCircle2 className="h-4 w-4 text-[var(--color-success-300)]" />}
              label="Pitched"
              value={pitched}
              tone="success"
            />
          )}
          {websitePitch > 0 && (
            <Tile
              icon={<Globe className="h-4 w-4 text-[var(--color-info-300)]" />}
              label="Website pitch"
              value={websitePitch}
              tone="info"
            />
          )}
          {review > 0 && (
            <Tile
              icon={<TriangleAlert className="h-4 w-4 text-[var(--color-warning-300)]" />}
              label="Need review"
              value={review}
              tone="warning"
            />
          )}
          {suppressed > 0 && (
            <Tile
              icon={<ShieldOff className="h-4 w-4 text-[var(--color-fg-500)]" />}
              label="Suppressed"
              value={suppressed}
              tone="neutral"
            />
          )}
          {errors > 0 && (
            <Tile
              icon={<XCircle className="h-4 w-4 text-[var(--color-danger-300)]" />}
              label="Errors"
              value={errors}
              tone="danger"
            />
          )}
        </div>
      )}

      {prunedStats && prunedStats.deleted > 0 && (
        <p className="text-xs text-[var(--color-fg-600)]">
          Kept top {prunedStats.kept} · deleted {prunedStats.deleted} low-scorers
        </p>
      )}

      {results.length === 0 && discoverStats?.new === 0 && (
        <p className="text-xs text-[var(--color-fg-500)]">
          No new prospects found. Try a different keyword or location.
        </p>
      )}
    </div>
  );
}

function Tile({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "success" | "warning" | "neutral" | "danger" | "info";
}) {
  const bg = {
    success: "bg-[var(--color-success-950)]",
    warning: "bg-[var(--color-warning-950)]",
    neutral: "bg-[var(--color-bg-800)]",
    danger: "bg-[var(--color-danger-950)]",
    info: "bg-[var(--color-info-950)]",
  }[tone];

  return (
    <div
      className={`flex items-center gap-2 rounded-[var(--radius-md)] p-2.5 ring-1 ring-inset ring-[var(--color-border-subtle)] ${bg}`}
    >
      {icon}
      <div className="min-w-0">
        <p className="text-lg font-bold leading-none text-[var(--color-fg-100)]">{value}</p>
        <p className="text-[10px] text-[var(--color-fg-500)]">{label}</p>
      </div>
    </div>
  );
}
