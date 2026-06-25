"use client";

/**
 * RunAllModal — "Run All Sources + Auto-Pipeline".
 *
 * The run is driven by a SERVER-SIDE background job (discovery_jobs + the
 * self-chaining /api/discover/run worker), NOT the browser. We just kick it off
 * (startDiscoveryJob), then poll getDiscoveryJob for progress. Closing this
 * drawer or the whole tab does NOT stop the run — reopening resumes the live
 * view via getActiveJobForIcp. A dedicated Stop button cancels it server-side.
 *
 * Step 1: Pick ICP → preview queries
 * Step 2: Running (discovering → pipeline → pruning), with Stop
 * Step 3: Summary
 */

import {
  CheckCircle2,
  Globe,
  Loader2,
  Play,
  ShieldOff,
  Square,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { Button } from "@/components/ui/button";
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
import { previewRunAllSources, type RunAllPreview } from "@/lib/discover/run-all-action";
import { getRawProspectIds, discardRawProspects } from "@/lib/discover/pipeline-action";
import {
  startDiscoveryJob,
  cancelDiscoveryJob,
  resumeDiscoveryJob,
  getDiscoveryJob,
  getActiveJobForIcp,
} from "@/lib/discover/job-actions";
import type { DiscoveryJob } from "@/lib/discover/job-types";

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = "pick" | "running" | "done";

interface RunAllModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icps: { id: string; name: string; market: string }[];
}

const POLL_MS = 3000;
// Re-kick a job whose heartbeat is staler than this (a healthy slice bumps it
// every ~40s). Matches the server-side STALL_MS guard in resumeDiscoveryJob.
const STALL_RESUME_MS = 100_000;

// ── Component ─────────────────────────────────────────────────────────────────

export function RunAllModal({ open, onOpenChange, icps }: RunAllModalProps) {
  const [step, setStep] = React.useState<Step>("pick");
  const [selectedIcpId, setSelectedIcpId] = React.useState<string>(icps[0]?.id ?? "");
  const [preview, setPreview] = React.useState<RunAllPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingRawCount, setPendingRawCount] = React.useState(0);

  const [jobId, setJobId] = React.useState<string | null>(null);
  const [job, setJob] = React.useState<DiscoveryJob | null>(null);
  const [stopping, setStopping] = React.useState(false);
  const [discarding, setDiscarding] = React.useState(false);
  const [discardMsg, setDiscardMsg] = React.useState<string | null>(null);

  // Only initialise ICP selection on first open — never reset mid-run.
  React.useEffect(() => {
    if (open && !selectedIcpId) {
      setSelectedIcpId(icps[0]?.id ?? "");
    }
  }, [open, icps, selectedIcpId]);

  // On open / ICP change while picking: load preview, raw count, AND resume any
  // in-flight job for this ICP (so closing+reopening shows the live run).
  React.useEffect(() => {
    if (!open || !selectedIcpId || step !== "pick") return;
    let cancelled = false;
    setLoadingPreview(true);
    setPendingRawCount(0);
    setDiscardMsg(null);

    void getActiveJobForIcp(selectedIcpId).then((active) => {
      if (cancelled || !active) return;
      setJob(active);
      setJobId(active.id);
      setStep("running");
    });

    Promise.all([
      previewRunAllSources(selectedIcpId).then((p) => {
        if (!cancelled) setPreview(p);
      }),
      getRawProspectIds(selectedIcpId).then((r) => {
        if (!cancelled) setPendingRawCount(r.ok ? r.ids.length : 0);
      }),
    ]).finally(() => {
      if (!cancelled) setLoadingPreview(false);
    });

    return () => {
      cancelled = true;
    };
  }, [selectedIcpId, step, open]);

  // Poll the job while it's running. The server keeps working regardless; this
  // just refreshes the on-screen progress.
  React.useEffect(() => {
    if (!jobId || step !== "running") return;
    let active = true;

    const tick = async () => {
      const j = await getDiscoveryJob(jobId);
      if (!active) return;
      if (j) {
        setJob(j);
        if (j.status !== "running") {
          setStep("done");
          return; // stop polling
        }
        // Watchdog: if the server chain died (slice killed by the 120s cap or a
        // dropped trigger), the heartbeat goes stale — re-kick it ourselves so a
        // stall recovers in seconds instead of waiting for the daily janitor.
        const staleMs = Date.now() - new Date(j.heartbeat_at).getTime();
        if (staleMs > STALL_RESUME_MS) {
          void resumeDiscoveryJob(jobId);
        }
      }
      if (active) timer = window.setTimeout(tick, POLL_MS);
    };
    let timer = window.setTimeout(tick, 0);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [jobId, step]);

  const beginJob = async (mode: "full" | "pending") => {
    if (!selectedIcpId) return;
    setError(null);
    setJob(null);
    setStopping(false);
    const res = await startDiscoveryJob(selectedIcpId, mode);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setJobId(res.jobId);
    setStep("running");
  };

  const handleStop = async () => {
    if (!jobId) return;
    setStopping(true);
    await cancelDiscoveryJob(jobId);
    // Polling will pick up the 'cancelled' status and flip to done.
  };

  const handleDiscard = async () => {
    if (!selectedIcpId) return;
    setDiscarding(true);
    setDiscardMsg(null);
    const res = await discardRawProspects(selectedIcpId);
    if (res.ok) {
      setPendingRawCount(0);
      setDiscardMsg(
        res.deleted > 0
          ? `Discarded ${res.deleted} raw prospect${res.deleted === 1 ? "" : "s"}.`
          : "No raw prospects to discard for this ICP.",
      );
    } else {
      setError(res.error);
    }
    setDiscarding(false);
  };

  const handleReset = () => {
    setStep("pick");
    setJobId(null);
    setJob(null);
    setError(null);
    setStopping(false);
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
            <AnimatePresence mode="wait">
              {step === "pick" && (
                <motion.div
                  key="pick"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                  className="flex flex-col gap-4"
                >
                  <PickStep
                    icps={icps}
                    selectedIcpId={selectedIcpId}
                    onSelectIcp={setSelectedIcpId}
                    preview={preview}
                    loadingPreview={loadingPreview}
                    error={error}
                    pendingRawCount={pendingRawCount}
                    onProcessPending={() => void beginJob("pending")}
                    onDiscardPending={() => void handleDiscard()}
                    discarding={discarding}
                    discardMsg={discardMsg}
                  />
                </motion.div>
              )}
              {step === "running" && (
                <motion.div
                  key="running"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                >
                  <RunningStep job={job} />
                </motion.div>
              )}
              {step === "done" && (
                <motion.div
                  key="done"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                >
                  <DoneStep job={job} />
                </motion.div>
              )}
            </AnimatePresence>
          </DrawerBody>

          <DrawerFooter>
            {step === "pick" && (
              <>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  className="min-w-0 max-w-[16rem]"
                  disabled={!selectedIcpId || loadingPreview}
                  onClick={() => void beginJob("full")}
                >
                  <Play className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">
                    {activeIcp ? `Run for ${activeIcp.name}` : "Run"}
                  </span>
                </Button>
              </>
            )}
            {step === "running" && (
              <>
                <p className="mr-auto text-[11px] text-[var(--color-fg-600)]">
                  Runs in the background — you can close this.
                </p>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Hide
                </Button>
                <Button variant="danger" onClick={handleStop} disabled={stopping}>
                  {stopping ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Square className="h-3.5 w-3.5" aria-hidden />
                  )}
                  Stop
                </Button>
              </>
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
  onDiscardPending,
  discarding,
  discardMsg,
}: {
  icps: { id: string; name: string; market: string }[];
  selectedIcpId: string;
  onSelectIcp: (id: string) => void;
  preview: RunAllPreview | null;
  loadingPreview: boolean;
  error: string | null;
  pendingRawCount: number;
  onProcessPending: () => void;
  onDiscardPending: () => void;
  discarding: boolean;
  discardMsg: string | null;
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
            New prospects will be automatically scraped, researched, scored, and triaged — in the background.
          </p>
        </div>
      )}

      {pendingRawCount > 0 && (
        <div className="flex flex-col gap-2 rounded-[var(--radius-md)] px-3 py-2.5 bg-[var(--color-warning-950)] ring-1 ring-inset ring-[var(--color-warning-800)]">
          <span className="flex items-center gap-1.5 text-xs text-[var(--color-warning-300)]">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {pendingRawCount} raw prospect{pendingRawCount === 1 ? "" : "s"} from a stopped/leftover run
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="flex-1"
              disabled={discarding}
              onClick={onProcessPending}
            >
              <Play className="h-3.5 w-3.5" aria-hidden />
              Run pipeline
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={discarding}
              onClick={onDiscardPending}
              className="text-[var(--color-danger-300)]"
            >
              {discarding ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              )}
              Discard
            </Button>
          </div>
        </div>
      )}

      {discardMsg && (
        <p className="text-xs text-[var(--color-fg-500)]">
          <CheckCircle2 className="inline-block h-3.5 w-3.5 mr-1 text-[var(--color-success-300)]" aria-hidden />
          {discardMsg}
        </p>
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

const PHASE_LABEL: Record<string, string> = {
  discovering: "Discovering across all sources…",
  pipeline: "Scraping, researching, scoring & triaging…",
  pruning: "Keeping the strongest prospects…",
  pitching: "Writing pitches for the top prospects…",
};

function RunningStep({ job }: { job: DiscoveryJob | null }) {
  if (!job) {
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--color-primary-400)]" aria-hidden />
        <p className="text-sm font-medium text-[var(--color-fg-200)]">Starting run…</p>
      </div>
    );
  }

  const { phase, stats } = job;
  const total = job.total;
  const done = Math.min(job.cursor, total);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="flex flex-col gap-4 py-2">
      <div className="flex items-center gap-2">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--color-primary-400)]" aria-hidden />
        <p className="text-sm font-medium text-[var(--color-fg-200)]">
          {PHASE_LABEL[phase] ?? "Running…"}
        </p>
      </div>

      {/* Discovery counters */}
      {(stats.new > 0 || stats.dup > 0) && (
        <p className="text-xs text-[var(--color-fg-500)]">
          Found <span className="text-[var(--color-success-300)] font-medium">+{stats.new} new</span> · {stats.dup} duplicates
          {stats.partial && (
            <span className="text-[var(--color-warning-300)]"> · discovery timed out, processing what was inserted</span>
          )}
        </p>
      )}

      {/* Pipeline / pitching progress */}
      {(phase === "pipeline" || phase === "pruning" || phase === "pitching") && total > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-[var(--color-fg-400)]">
            <span>{phase === "pitching" ? "Writing pitches" : "Processing prospects"}</span>
            <span>{done} / {total}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-[var(--color-bg-900)] overflow-hidden">
            <div
              className="h-full rounded-full bg-[var(--color-primary-500)] transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <OutcomeTallies stats={stats} />
        </div>
      )}
    </div>
  );
}

function OutcomeTallies({ stats }: { stats: DiscoveryJob["stats"] }) {
  const items: { label: string; value: number; node: React.ReactNode }[] = [
    { label: "Pitched", value: stats.pitched, node: <CheckCircle2 className="h-3 w-3 text-[var(--color-success-300)]" /> },
    { label: "Website pitch", value: stats.website_pitch, node: <Globe className="h-3 w-3 text-[var(--color-info-300)]" /> },
    { label: "Review", value: stats.needs_review, node: <TriangleAlert className="h-3 w-3 text-[var(--color-warning-300)]" /> },
    { label: "Suppressed", value: stats.suppressed, node: <ShieldOff className="h-3 w-3 text-[var(--color-fg-500)]" /> },
    { label: "Errors", value: stats.error_count, node: <XCircle className="h-3 w-3 text-[var(--color-danger-300)]" /> },
  ].filter((i) => i.value > 0);

  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-fg-500)]">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1">
          {i.node} {i.value} {i.label}
        </span>
      ))}
    </div>
  );
}

function DoneStep({ job }: { job: DiscoveryJob | null }) {
  if (!job) return null;
  const { status, stats } = job;
  const cancelled = status === "cancelled";
  const failed = status === "failed";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        {failed ? (
          <XCircle className="h-5 w-5 text-[var(--color-danger-300)]" aria-hidden />
        ) : cancelled ? (
          <Square className="h-5 w-5 text-[var(--color-fg-500)]" aria-hidden />
        ) : (
          <CheckCircle2 className="h-5 w-5 text-[var(--color-success-300)]" aria-hidden />
        )}
        <p className="text-sm font-semibold text-[var(--color-fg-100)]">
          {failed ? "Run failed" : cancelled ? "Stopped" : "All done"}
        </p>
      </div>

      {failed && job.error_message && (
        <p className="text-xs text-[var(--color-danger-300)]">{job.error_message}</p>
      )}

      <div className="text-xs text-[var(--color-fg-400)] space-y-0.5">
        {stats.partial ? (
          <p className="text-[var(--color-warning-300)]">
            Discovery timed out — processed {stats.new} prospects that were inserted. Run again to discover more.
          </p>
        ) : (
          <p>
            Discovered{" "}
            <span className="text-[var(--color-success-300)] font-medium">+{stats.new}</span> new prospects · {stats.dup} duplicates skipped
          </p>
        )}
      </div>

      {(stats.pitched + stats.website_pitch + stats.needs_review + stats.suppressed + stats.error_count) > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {stats.pitched > 0 && (
            <Tile icon={<CheckCircle2 className="h-4 w-4 text-[var(--color-success-300)]" />} label="Pitched" value={stats.pitched} tone="success" />
          )}
          {stats.website_pitch > 0 && (
            <Tile icon={<Globe className="h-4 w-4 text-[var(--color-info-300)]" />} label="Website pitch" value={stats.website_pitch} tone="info" />
          )}
          {stats.needs_review > 0 && (
            <Tile icon={<TriangleAlert className="h-4 w-4 text-[var(--color-warning-300)]" />} label="Need review" value={stats.needs_review} tone="warning" />
          )}
          {stats.suppressed > 0 && (
            <Tile icon={<ShieldOff className="h-4 w-4 text-[var(--color-fg-500)]" />} label="Suppressed" value={stats.suppressed} tone="neutral" />
          )}
          {stats.error_count > 0 && (
            <Tile icon={<XCircle className="h-4 w-4 text-[var(--color-danger-300)]" />} label="Errors" value={stats.error_count} tone="danger" />
          )}
        </div>
      )}

      {typeof stats.pruned_deleted === "number" && stats.pruned_deleted > 0 && (
        <p className="text-xs text-[var(--color-fg-600)]">
          Kept top {stats.pruned_kept} · deleted {stats.pruned_deleted} low-scorers
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
