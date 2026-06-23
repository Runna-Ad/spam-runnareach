"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { scoreProspect } from "@/lib/research/score-action";
import { generatePitch } from "@/lib/pitches/actions";
import { processSingleProspect } from "@/lib/discover/pipeline-action";
import { enrichContactsForProspect } from "@/lib/discover/enrich-contacts";
import { hasUsableEmail } from "@/lib/research/email-utils";
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

// Pitch generation is a Sonnet call each (~15-20s) — cap low and run in
// concurrent chunks so a batch fits the 60s Vercel function budget.
const bulkGenerateSchema = z.object({
  prospect_ids: z.array(z.string().uuid()).min(1).max(10),
});
const GENERATE_CHUNK = 5;
/** Prospect statuses already past the drafting stage — don't re-draft these. */
const ADVANCED_STATUSES = new Set(["sent", "replied", "booked", "won", "lost", "ghosted", "bounced"]);

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
  const priorById = new Map(
    ((priorRows ?? []) as Array<{ id: string; status: string }>).map((r) => [r.id, r.status]),
  );

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

const bulkDeleteSchema = z.object({
  prospect_ids: z.array(z.string().uuid()).min(1).max(500),
});

/**
 * Hard-delete N prospects. Cascades to research, scores, pitches, and contacts
 * (all FKs are `on delete cascade`). Prospects that have a booked opportunity
 * are protected by `opportunities.prospect_id on delete restrict` — we detect
 * those up front and skip them rather than letting the whole batch fail, so a
 * stray won deal can never be wiped by a bulk cleanup.
 *
 * This is the UI replacement for hand-running `DELETE FROM prospects` in SQL.
 */
export async function bulkDeleteProspects(
  input: z.input<typeof bulkDeleteSchema>,
): Promise<BulkResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot delete prospects." };
  }

  const parsed = bulkDeleteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const ids = parsed.data.prospect_ids;

  // Protect prospects that became real opportunities (booked deals).
  // `opportunities` isn't in the generated Supabase types yet, so this one
  // query is cast to bypass inference (same pattern as lib/warmup/queries.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: oppRows } = await (supabase as any)
    .from("opportunities")
    .select("prospect_id")
    .in("prospect_id", ids)
    .eq("tenant_id", user.tenantId);
  const protectedIds = new Set(
    ((oppRows ?? []) as Array<{ prospect_id: string }>).map((r) => r.prospect_id),
  );
  const deletableIds = ids.filter((id) => !protectedIds.has(id));

  if (deletableIds.length === 0) {
    return {
      ok: false,
      error: "All selected prospects have booked opportunities and can't be deleted.",
    };
  }

  // Capture names for the audit trail before the rows vanish.
  const { data: nameRows } = await supabase
    .from("prospects")
    .select("id, company_name")
    .in("id", deletableIds)
    .eq("tenant_id", user.tenantId);
  const nameById = new Map(
    ((nameRows ?? []) as Array<{ id: string; company_name: string }>).map((r) => [
      r.id,
      r.company_name,
    ]),
  );

  const { error, count } = await supabase
    .from("prospects")
    .delete({ count: "exact" })
    .in("id", deletableIds)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not delete: ${error.message}` };

  await Promise.all(
    deletableIds.map((id) =>
      writeAuditLog({
        tenantId: user.tenantId,
        actorId: user.id,
        action: "prospect.deleted",
        entityType: "prospect",
        entityId: id,
        metadata: { company_name: nameById.get(id) ?? null, via: "bulk" },
      }),
    ),
  );

  revalidatePath("/companies");
  revalidatePath("/funnel");
  revalidatePath("/dashboard");

  const skipped = protectedIds.size;
  return {
    ok: true,
    affected: count ?? deletableIds.length,
    failed: skipped,
    details:
      skipped > 0
        ? `${skipped} skipped (booked opportunity — can't delete)`
        : undefined,
  };
}

const bulkPipelineSchema = z.object({ prospect_ids: z.array(z.string().uuid()).min(1).max(20) });

/**
 * Run the full pipeline (scrape → research → score → enrich → pitch) on N prospects.
 * Capped at 20 to avoid Vercel timeout — each prospect takes ~15–30s.
 */
export async function bulkRunPipeline(
  input: z.input<typeof bulkPipelineSchema>,
): Promise<BulkResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot run pipeline." };

  const parsed = bulkPipelineSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const results = await Promise.all(parsed.data.prospect_ids.map((id) => processSingleProspect(id)));

  const affected = results.filter((r) => r.outcome !== "error").length;
  const failed = results.length - affected;
  const firstErr = results.find((r) => r.outcome === "error");

  revalidatePath("/companies");
  revalidatePath("/funnel");
  revalidatePath("/pitches");
  revalidatePath("/dashboard");

  return {
    ok: true,
    affected,
    failed,
    details: failed > 0 && firstErr ? `First error: ${firstErr.error ?? "unknown"}` : undefined,
  };
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

  const ids = parsed.data.prospect_ids;
  const results = await Promise.all(ids.map((id) => scoreProspect(id)));

  const affected = results.filter((r) => r.ok).length;
  const failed = results.length - affected;
  const firstErr = results.find((r) => !r.ok);

  // ── Symmetric re-score triage ─────────────────────────────────────────────
  // Mirror the pipeline's gate so bulk re-scoring keeps statuses honest:
  //   score < 40  → suppress (only from early funnel states)
  //   score ≥ 40 AND auto-suppressed before → un-suppress back to "researched"
  // We only ever touch raw/researched/auto-suppressed rows — never a manually
  // suppressed prospect or one a human advanced (pitched/replied/booked/won/lost).
  const scoreById = new Map<string, number>();
  ids.forEach((id, i) => {
    const r = results[i];
    if (r?.ok) scoreById.set(id, r.composite_score);
  });

  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  type StatusRow = { id: string; status: string; suppressed_reason: string | null };
  const { data: statusRows } = await supabase
    .from("prospects")
    .select("id, status, suppressed_reason")
    .in("id", [...scoreById.keys()])
    .eq("tenant_id", user.tenantId)
    .returns<StatusRow[]>();

  const toSuppress: string[] = [];
  const toRestore: string[] = [];
  for (const row of statusRows ?? []) {
    const score = scoreById.get(row.id);
    if (score === undefined) continue;
    if (score < 40 && (row.status === "raw" || row.status === "researched")) {
      toSuppress.push(row.id);
    } else if (
      score >= 40 &&
      ((row.status === "suppressed" && (row.suppressed_reason ?? "").startsWith("Auto:")) ||
        row.status === "no_match")
    ) {
      // Reactivate a parked prospect that now clears the bar (auto-suppressed
      // under an old score, or no_match-archived by the legacy scrape path).
      toRestore.push(row.id);
    }
  }

  if (toSuppress.length > 0) {
    await supabase
      .from("prospects")
      .update({
        status: "suppressed",
        suppressed_reason: "Auto: re-score below threshold",
        suppressed_at: nowIso,
        updated_at: nowIso,
      })
      .in("id", toSuppress)
      .eq("tenant_id", user.tenantId);
  }
  if (toRestore.length > 0) {
    // Restore to "researched" (scored, not yet pitched) and clear the auto-suppress.
    await supabase
      .from("prospects")
      .update({
        status: "researched",
        suppressed_reason: null,
        suppressed_at: null,
        updated_at: nowIso,
      })
      .in("id", toRestore)
      .eq("tenant_id", user.tenantId);
  }

  await Promise.all(
    [...toSuppress, ...toRestore].map((id) =>
      writeAuditLog({
        tenantId: user.tenantId,
        actorId: user.id,
        action: "prospect.status_changed",
        entityType: "prospect",
        entityId: id,
        metadata: {
          via: "bulk_rescore",
          to: toSuppress.includes(id) ? "suppressed" : "researched",
          score: scoreById.get(id) ?? null,
        },
      }),
    ),
  );

  // ── Contact enrichment for high scorers (≥70) ─────────────────────────────
  // A high fit score is worthless without someone to email. For every ≥70
  // prospect that has no contact yet, run the waterfall (SnapVerify → Anymail →
  // Hunter), then mark pitch-readiness: a contact was found → pitch_gate_passed,
  // still nothing after all tiers → flagged not-ready. Keeps the fit score
  // honest while ensuring "≥70 + ready" actually means reachable.
  let enrichedCount = 0;
  let noContactCount = 0;
  const HIGH_SCORE = 70;
  const highIds = [...scoreById.entries()]
    .filter(([, s]) => s >= HIGH_SCORE)
    .map(([id]) => id);

  if (highIds.length > 0) {
    type CRow = { prospect_id: string; email_is_role_based: boolean | null };
    const loadContacts = async (ids: string[]) =>
      (
        await supabase
          .from("prospect_contacts")
          .select("prospect_id, email_is_role_based")
          .in("prospect_id", ids)
          .eq("tenant_id", user.tenantId)
          .not("email", "is", null)
          .returns<CRow[]>()
      ).data ?? [];

    const before = await loadContacts(highIds);
    const hasAnyEmail = new Set(before.map((r) => r.prospect_id));
    // A PERSONAL email is a real decision-maker target. A role-based-only
    // contact (info@, support@) still needs enrichment to find a person.
    const hasPersonal = new Set(
      before.filter((r) => !r.email_is_role_based).map((r) => r.prospect_id),
    );
    const missing = highIds.filter((id) => !hasPersonal.has(id));

    if (missing.length > 0) {
      type PRow = { id: string; domain: string | null; company_name: string };
      const { data: pRows } = await supabase
        .from("prospects")
        .select("id, domain, company_name")
        .in("id", missing)
        .eq("tenant_id", user.tenantId)
        .returns<PRow[]>();

      // Run the (paid) waterfall in small parallel chunks to respect API rate
      // limits and stay within the server-action time budget.
      const CHUNK = 4;
      const enrichable = (pRows ?? []).filter((p) => p.domain);
      for (let i = 0; i < enrichable.length; i += CHUNK) {
        await Promise.all(
          enrichable.slice(i, i + CHUNK).map((p) =>
            enrichContactsForProspect(
              user.tenantId,
              p.id,
              p.domain as string,
              p.company_name,
              supabase,
              false,
            ).catch((err) => {
              console.error(`[bulkScore] enrich failed for ${p.id}:`, err);
            }),
          ),
        );
      }

      // Re-check the previously-missing prospects.
      const after = await loadContacts(missing);
      after.forEach((r) => {
        hasAnyEmail.add(r.prospect_id);
        if (!r.email_is_role_based) hasPersonal.add(r.prospect_id);
      });
      enrichedCount = missing.filter((id) => hasPersonal.has(id)).length;
      noContactCount = missing.filter((id) => !hasAnyEmail.has(id)).length;
    }

    // Pitch-readiness gate: a ≥70 prospect with ANY valid email (personal OR
    // role-based — both deliverable) is ready; no email at all → flagged.
    const ready = highIds.filter((id) => hasAnyEmail.has(id));
    const notReady = highIds.filter((id) => !hasAnyEmail.has(id));
    if (ready.length > 0) {
      await supabase
        .from("prospects")
        .update({ pitch_gate_passed: true, updated_at: nowIso })
        .in("id", ready)
        .eq("tenant_id", user.tenantId);
    }
    if (notReady.length > 0) {
      await supabase
        .from("prospects")
        .update({ pitch_gate_passed: false, updated_at: nowIso })
        .in("id", notReady)
        .eq("tenant_id", user.tenantId);
    }
  }

  revalidatePath("/companies");
  revalidatePath("/funnel");
  revalidatePath("/dashboard");

  const triageNote = [
    toSuppress.length > 0 ? `${toSuppress.length} suppressed (<40)` : null,
    toRestore.length > 0 ? `${toRestore.length} restored (≥40)` : null,
    enrichedCount > 0 ? `${enrichedCount} decision-maker${enrichedCount === 1 ? "" : "s"} found` : null,
    noContactCount > 0 ? `${noContactCount} still unreachable` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    ok: true,
    affected,
    failed,
    details:
      failed > 0 && firstErr && !firstErr.ok
        ? `First error: ${firstErr.error}`
        : triageNote || undefined,
  };
}

/**
 * Generate draft pitches for several prospects at once (instead of 1-by-1).
 * Pre-filters the selection — skips prospects with no contact email (can't send)
 * and ones already past the draft stage (sent/replied/booked/…) — then composes
 * the rest in concurrent chunks so the batch fits the function budget. Each
 * draft lands on /pitches for review, exactly like the single-prospect button.
 */
export async function bulkGeneratePitches(
  input: z.input<typeof bulkGenerateSchema>,
): Promise<BulkResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot generate pitches." };

  const parsed = bulkGenerateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const ids = parsed.data.prospect_ids;

  // ── Pre-filter: need a real contact + not already past drafting ────────────
  const [{ data: pros }, { data: contactRows }] = await Promise.all([
    supabase
      .from("prospects")
      .select("id, status")
      .in("id", ids)
      .eq("tenant_id", user.tenantId)
      .returns<{ id: string; status: string }[]>(),
    supabase
      .from("prospect_contacts")
      .select("prospect_id, email")
      .in("prospect_id", ids)
      .eq("tenant_id", user.tenantId)
      .returns<{ prospect_id: string; email: string | null }[]>(),
  ]);

  const statusById = new Map((pros ?? []).map((p) => [p.id, p.status]));
  const hasContact = new Set(
    (contactRows ?? []).filter((c) => hasUsableEmail(c.email)).map((c) => c.prospect_id),
  );

  let skippedNoContact = 0;
  let skippedAdvanced = 0;
  const toGenerate: string[] = [];
  for (const id of ids) {
    const status = statusById.get(id);
    if (status === undefined) continue; // not in tenant / deleted
    if (ADVANCED_STATUSES.has(status)) { skippedAdvanced += 1; continue; }
    if (!hasContact.has(id)) { skippedNoContact += 1; continue; }
    toGenerate.push(id);
  }

  // ── Compose in concurrent chunks (pass injected user+supabase so generatePitch
  //    doesn't re-auth inside this nested server-action chain) ─────────────────
  let generated = 0;
  let failed = 0;
  for (let i = 0; i < toGenerate.length; i += GENERATE_CHUNK) {
    const chunk = toGenerate.slice(i, i + GENERATE_CHUNK);
    const res = await Promise.all(
      chunk.map((id) => generatePitch(id, { user, supabase })),
    );
    for (const r of res) {
      if (r.ok) generated += 1;
      else failed += 1;
    }
  }

  revalidatePath("/companies");
  revalidatePath("/pitches");
  revalidatePath("/funnel");

  const skips = [
    skippedNoContact > 0 ? `${skippedNoContact} no contact` : null,
    skippedAdvanced > 0 ? `${skippedAdvanced} already sent/replied` : null,
    failed > 0 ? `${failed} failed` : null,
  ].filter(Boolean);

  return {
    ok: true,
    affected: generated,
    failed: failed + skippedNoContact + skippedAdvanced,
    details: skips.length > 0 ? `skipped: ${skips.join(", ")}` : undefined,
  };
}
