// ─────────────────────────────────────────────────────────────────────────────
// app/api/discover/janitor/route.ts
// Background-discovery janitor — fails jobs whose self-chaining worker died.
//
// A healthy job bumps heartbeat_at every slice (seconds apart). If a job is
// still 'running' but its heartbeat has gone stale, the chain was lost (worker
// crash, dropped trigger, deploy mid-run) and it will never finish on its own.
// This sweep marks such jobs 'failed' so the UI stops showing them as running
// and the user can re-run. Uses the service-role key (bypasses RLS) since it has
// no user session.
//
// Auth: Authorization: Bearer <CRON_SECRET>.
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// Slices run seconds apart; 5 min of silence means the chain is dead.
const STALE_MINUTES = 5;

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();

  const { data, error } = await supabase
    .from("discovery_jobs")
    .update({
      status: "failed",
      error_message: "Worker chain stalled (stale heartbeat) — please run again.",
      completed_at: new Date().toISOString(),
    } as never)
    .eq("status", "running")
    .lt("heartbeat_at", cutoff)
    .select("id");

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, failed: data?.length ?? 0 });
}
