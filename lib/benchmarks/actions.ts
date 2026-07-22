"use server";

/**
 * Activating a benchmark is the human approval step the whole table depends on.
 *
 * Rows arrive inert: is_active false, verified_at null. Nothing can be quoted in
 * a pitch until someone reads the caveat and turns it on — and the table's CHECK
 * constraint (is_active = false or verified_at is not null) makes that ordering
 * impossible to skip from any client.
 *
 * Why this matters more than a normal toggle: every row carries a real citation,
 * but a citation is not the same as being APPLICABLE. Several rows here are US
 * data being shown to Canadian prospects, or vendor research with a commercial
 * interest in the finding, or 15 years old. Only a human can decide whether a
 * given number is one they're willing to defend when a prospect asks where it
 * came from — so the act of activating records WHO decided.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const toggleSchema = z.object({
  benchmark_id: z.string().uuid(),
  is_active: z.boolean(),
});

export type BenchmarkActionResult = { ok: true } | { ok: false; error: string };

export async function setBenchmarkActive(
  input: z.input<typeof toggleSchema>,
): Promise<BenchmarkActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot change benchmarks." };
  }

  const parsed = toggleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();

  // Activating stamps the approval; deactivating leaves it, so the record of who
  // vetted the row survives being switched off and back on.
  // updated_at is handled by the set_updated_at trigger (attached explicitly in
  // migration 0029 — 0001's loop only covered tables that existed then).
  const payload = parsed.data.is_active
    ? {
        is_active: true,
        verified_by: user.id,
        verified_at: new Date().toISOString(),
      }
    : { is_active: false };

  const { error } = await supabase
    .from("benchmarks")
    .update(payload)
    .eq("id", parsed.data.benchmark_id)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not update: ${error.message}` };

  revalidatePath("/benchmarks");
  return { ok: true };
}
