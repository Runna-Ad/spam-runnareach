"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { scoreProspect } from "@/lib/research/score-action";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";

type ProspectUpdate = Database["public"]["Tables"]["prospects"]["Update"];

const STATUS_VALUES = [
  "raw",
  "researched",
  "pitched",
  "replied",
  "booked",
  "won",
  "lost",
  "suppressed",
] as const;

const bulkStatusSchema = z.object({
  prospect_ids: z.array(z.string().uuid()).min(1).max(500),
  next_status: z.enum(STATUS_VALUES),
  suppressed_reason: z.string().trim().max(200).nullable().optional(),
});

const bulkScoreSchema = z.object({
  prospect_ids: z.array(z.string().uuid()).min(1).max(100),
});

export type BulkResult =
  | { ok: true; affected: number; failed: number; details?: string }
  | { ok: false; error: string };

/**
 * Bulk-set status across N prospects in a single round-trip.
 * RLS isolates by tenant — even if a foreign id sneaks in, it won't match.
 * Audit log captures one entry per prospect (so the activity feed shows
 * "Status: raw → researched" against each).
 */
export async function bulkTransitionStatus(
  input: z.input<typeof bulkStatusSchema>,
): Promise<BulkResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot change status." };
  }

  const parsed = bulkStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  // Capture prior statuses so audit reads "from → to".
  const { data: priorRows } = await supabase
    .from("prospects")
    .select("id, status")
    .in("id", parsed.data.prospect_ids)
    .eq("tenant_id", user.tenantId);
  const priorById = new Map((priorRows ?? []).map((r) => [r.id, r.status]));

  const payload: ProspectUpdate = {
    status: parsed.data.next_status,
    updated_at: nowIso,
  };
  if (parsed.data.next_status === "suppressed") {
    payload.suppressed_at = nowIso;
    payload.suppressed_reason =
      parsed.data.suppressed_reason ?? "manual bulk suppression";
  } else {
    payload.suppressed_at = null;
    payload.suppressed_reason = null;
  }

  const { error, count } = await supabase
    .from("prospects")
    .update(payload, { count: "exact" })
    .in("id", parsed.data.prospect_ids)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not update: ${error.message}` };

  // Audit one entry per prospect so the per-prospect activity tab
  // surfaces the change. Run sequentially — these are best-effort.
  await Promise.all(
    parsed.data.prospect_ids.map((id) =>
      writeAuditLog({
        tenantId: user.tenantId,
        actorId: user.id,
        action: "prospect.status_changed",
        entityType: "prospect",
        entityId: id,
        metadata: {
          from: priorById.get(id) ?? null,
          to: parsed.data.next_status,
          suppressed_reason: parsed.data.suppressed_reason ?? null,
          via: "bulk",
        },
      }),
    ),
  );

  revalidatePath("/companies");
  revalidatePath("/funnel");
  revalidatePath("/dashboard");

  return { ok: true, affected: count ?? parsed.data.prospect_ids.length, failed: 0 };
}

/**
 * Bulk-score N prospects. Re-uses scoreProspect() per prospect so all
 * the same audit + scores-table writes happen, plus the per-prospect
 * match_score sync. Caps at 100 because each call hits the DB.
 *
 * Returns affected/failed counts; if any individual call errors, we
 * keep going (don't block the whole batch on one bad prospect).
 */
export async function bulkScoreProspects(
  input: z.input<typeof bulkScoreSchema>,
): Promise<BulkResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot score." };
  }

  const parsed = bulkScoreSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const results = await Promise.all(
    parsed.data.prospect_ids.map((id) => scoreProspect(id)),
  );

  const affected = results.filter((r) => r.ok).length;
  const failed = results.length - affected;
  const firstErr = results.find((r) => !r.ok);

  revalidatePath("/companies");
  revalidatePath("/funnel");
  revalidatePath("/dashboard");

  return {
    ok: true,
    affected,
    failed,
    details:
      failed > 0 && firstErr && !firstErr.ok ? `First error: ${firstErr.error}` : undefined,
  };
}
