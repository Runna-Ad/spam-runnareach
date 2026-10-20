/**
 * Client-safe types for background discovery jobs. No server imports here so
 * client components (run-all-modal) can import without dragging server-only code
 * into the bundle.
 */

export type DiscoveryJobStatus = "running" | "cancelled" | "done" | "failed";
export type DiscoveryJobPhase = "discovering" | "pipeline" | "pruning" | "pitching";

/** Aggregate counters + per-outcome tallies, persisted on discovery_jobs.stats. */
export type DiscoveryJobStats = {
  new: number;
  dup: number;
  errors: string[];
  partial?: boolean;
  // pipeline outcome tallies
  pitched: number;
  website_pitch: number;
  needs_review: number;
  suppressed: number;
  error_count: number;
  // prune summary
  pruned_kept?: number;
  pruned_deleted?: number;
  // target-seeking discovery loop: cumulative prospects researched this run (drives
  // the per-run safety cap) and the pitched-lead count last observed for the ICP.
  processed?: number;
  /**
   * Every prospect this run researched, across refills (`processed` counts
   * them). prospect_ids can't tell: each refill and the pitching phase
   * overwrite it with the next list to work through.
   */
  processed_ids?: string[];
  /**
   * Companies the pipeline phase was given but did not run because they were
   * already contacted or parked (isPastPipeline). Not part of `processed`.
   * The pitching phase's high-scorer filter is not counted: it ranges over the
   * ICP's whole pool (or re-sees ids this field already counted).
   */
  skipped?: number;
  pitched_pool?: number;
  // true for a manual "run these specific prospects" job — skip the top-30 prune
  // (the user hand-picked them; don't delete any).
  skip_prune?: boolean;
  /**
   * How many times the DISCOVERING phase has been entered for this job.
   *
   * That phase isn't resumable — a restart re-runs every crawl from scratch and
   * re-spends the API budget. If it consistently exceeds the serverless
   * duration cap it would be killed, resumed by the watchdog, killed again…
   * forever. This counter bounds that loop.
   */
  discover_attempts?: number;
  /**
   * Set by the autopilot's scout: the one search cell (keyword × region) this
   * job runs, so its yield can be credited to that cell. Absent for manual runs,
   * which search all of the ICP's keywords.
   */
  focus?: { keyword: string; region: string | null; cell_key: string };
  /**
   * Scout jobs only: the prospects this job's own crawl inserted. Its cell is
   * credited with these, whichever job researches them, and never with the
   * other crawls' prospects a refill picks up (lib/learning/scout.ts
   * scoutCredits). Empty when the crawl's own prospects couldn't be identified
   * and the job fell back to the ICP's raw pool.
   */
  found_ids?: string[];
  /** "autopilot" when the scout started the job. */
  started_by?: string;
  /** Research cap for this run: what's left of the autopilot's daily budget. */
  max_processed?: number;
  /** Why an autopilot job finished before its cap, e.g. the AI budget ran out. */
  stopped_reason?: string;
};

export type DiscoveryJob = {
  id: string;
  icp_id: string | null;
  status: DiscoveryJobStatus;
  phase: DiscoveryJobPhase;
  cursor: number;
  total: number; // prospect_ids.length
  stats: DiscoveryJobStats;
  error_message: string | null;
  heartbeat_at: string;
  created_at: string;
  completed_at: string | null;
};

export const EMPTY_JOB_STATS: DiscoveryJobStats = {
  new: 0,
  dup: 0,
  errors: [],
  pitched: 0,
  website_pitch: 0,
  needs_review: 0,
  suppressed: 0,
  error_count: 0,
};
