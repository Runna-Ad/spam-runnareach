/**
 * Client-safe types for background discovery jobs. No server imports here so
 * client components (run-all-modal) can import without dragging server-only code
 * into the bundle.
 */

export type DiscoveryJobStatus = "running" | "cancelled" | "done" | "failed";
export type DiscoveryJobPhase = "discovering" | "pipeline" | "pruning";

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
