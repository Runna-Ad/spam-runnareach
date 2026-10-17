// ─────────────────────────────────────────────────────────────────────────────
// app/api/autopilot/tick/route.ts
// The autopilot's heartbeat. Supabase pg_cron calls it every 15 minutes
// (migration 0041); it can also be called by hand with the cron secret.
//
// For every tenant whose autonomy_state is enabled, runs one tick as that
// tenant's system actor (lib/autopilot/tick.ts): breakers, watchdog, scout,
// labels, scheduling, stage. A tenant with the kill switch off is skipped.
//
// Auth: Authorization: Bearer <CRON_SECRET>, or pg_cron's Vault-held token
// (lib/cron-auth.ts isSchedulerAuthorized).
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest, NextResponse } from "next/server";
import { systemActorFor } from "@/lib/actor";
import { runTick, type TickReport } from "@/lib/autopilot/tick";
import { isSchedulerAuthorized } from "@/lib/cron-auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest) {
  if (!(await isSchedulerAuthorized(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // autonomy_state (0040) isn't in the generated types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServiceRoleClient() as any;
  const { data, error } = await supabase.from("autonomy_state").select("tenant_id").eq("enabled", true);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const reports: TickReport[] = [];
  for (const row of (data ?? []) as Array<{ tenant_id: string }>) {
    const actor = await systemActorFor(row.tenant_id);
    if (!actor) continue;
    reports.push(await runTick(actor));
  }
  return NextResponse.json({ ok: true, reports });
}

export const GET = handle;
export const POST = handle;
