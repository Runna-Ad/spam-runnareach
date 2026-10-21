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

const ALREADY_REVIEWED = "Already reviewed (approved or rejected in another tab). Reload the page.";

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

  // A rejected proposal stays rejected. The DB CHECK would refuse it too, but with
  // a raw constraint message; say it in words instead.
  if (parsed.data.is_active) {
    const { data: current } = await supabase
      .from("benchmarks")
      .select("rejected_at")
      .eq("id", parsed.data.benchmark_id)
      .eq("tenant_id", user.tenantId)
      .maybeSingle<{ rejected_at: string | null }>();
    if (current?.rejected_at) {
      return { ok: false, error: "This proposal was rejected, so it cannot be activated." };
    }
  }

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

  const base = supabase
    .from("benchmarks")
    .update(payload)
    .eq("id", parsed.data.benchmark_id)
    .eq("tenant_id", user.tenantId);

  if (parsed.data.is_active) {
    // Closes the gap between the read above and this write (another tab rejecting):
    // 0 rows matched means the row was rejected (or removed) in between.
    const { data, error } = await base.is("rejected_at", null).select("id");
    if (error) return { ok: false, error: `Could not update: ${error.message}` };
    if (!data || data.length === 0) return { ok: false, error: ALREADY_REVIEWED };
  } else {
    const { error } = await base;
    if (error) return { ok: false, error: `Could not update: ${error.message}` };
  }

  revalidatePath("/benchmarks");
  return { ok: true };
}

const proposalSchema = z.object({
  benchmark_id: z.string().uuid(),
  statistic: z.string().trim().min(1, "The sentence cannot be empty.").max(600),
  figure: z.string().trim().min(1, "The figure cannot be empty.").max(200),
  caveat: z
    .string()
    .trim()
    .max(1500)
    .nullish()
    .transform((v) => (v ? v : null)),
  industry_scope: z.array(z.string().trim().min(1).max(80)).max(30),
  market: z
    .string()
    .trim()
    .max(40)
    .nullish()
    .transform((v) => (v ? v : null)),
  is_vendor_sourced: z.boolean(),
});

/** The edit/reject WHERE: a proposal nobody has approved or rejected yet. */
function onlyOpenProposals<
  T extends {
    is(c: string, v: null): T;
    not(c: string, op: string, v: null): T;
  },
>(q: T): T {
  return q.is("verified_at", null).is("rejected_at", null).not("wanted_fact_id", "is", null);
}

export async function updateBenchmarkProposal(
  input: z.input<typeof proposalSchema>,
): Promise<BenchmarkActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot change benchmarks." };
  }

  const parsed = proposalSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { benchmark_id, ...fields } = parsed.data;

  const supabase = await createClient();
  const { data, error } = await onlyOpenProposals(
    supabase.from("benchmarks").update(fields).eq("id", benchmark_id).eq("tenant_id", user.tenantId),
  ).select("id");

  if (error) return { ok: false, error: `Could not save: ${error.message}` };
  if (!data || data.length === 0) return { ok: false, error: ALREADY_REVIEWED };

  revalidatePath("/benchmarks");
  return { ok: true };
}

const rejectSchema = z.object({ benchmark_id: z.string().uuid() });

/** Rejected rows are kept (not deleted) so research never proposes them again. */
export async function rejectBenchmarkProposal(
  input: z.input<typeof rejectSchema>,
): Promise<BenchmarkActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot change benchmarks." };
  }

  const parsed = rejectSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const { data, error } = await onlyOpenProposals(
    supabase
      .from("benchmarks")
      .update({ rejected_at: new Date().toISOString() })
      .eq("id", parsed.data.benchmark_id)
      .eq("tenant_id", user.tenantId),
  ).select("id, wanted_fact_id");

  if (error) return { ok: false, error: `Could not reject: ${error.message}` };
  const rejected = data?.[0];
  if (!rejected) return { ok: false, error: ALREADY_REVIEWED };

  // Research only looks at open / no_source facts. When this was the last live
  // proposal for its fact (nothing pending, nothing approved), put the fact back to
  // 'open' so the next run can look for a different source. A dismissed fact stays
  // dismissed: the WHERE only moves 'proposed'.
  if (rejected.wanted_fact_id) {
    const { data: others, error: othersError } = await supabase
      .from("benchmarks")
      .select("id")
      .eq("tenant_id", user.tenantId)
      .eq("wanted_fact_id", rejected.wanted_fact_id)
      .is("rejected_at", null)
      .limit(1);
    if (othersError) {
      return { ok: false, error: `Rejected, but could not check the fact: ${othersError.message}` };
    }
    if (!others || others.length === 0) {
      const { error: reopenError } = await supabase
        .from("wanted_facts")
        .update({ status: "open" })
        .eq("id", rejected.wanted_fact_id)
        .eq("tenant_id", user.tenantId)
        .eq("status", "proposed");
      if (reopenError) {
        return { ok: false, error: `Rejected, but could not reopen the fact: ${reopenError.message}` };
      }
    }
  }

  revalidatePath("/benchmarks");
  return { ok: true };
}

const wantedFactSchema = z.object({
  fact: z.string().trim().min(1, "Write the fact you want a source for."),
  pain_code: z
    .string()
    .trim()
    .max(80)
    .nullish()
    .transform((v) => (v ? v : null)),
});

/** Length rules live in the database (8 to 300 characters); its error is shown in words. */
export async function addWantedFact(
  input: z.input<typeof wantedFactSchema>,
): Promise<BenchmarkActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot change benchmarks." };
  }

  const parsed = wantedFactSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("record_wanted_fact", {
    p_tenant_id: user.tenantId,
    p_fact: parsed.data.fact,
    p_source: "manual",
    p_pain_code: parsed.data.pain_code,
  });

  if (error) {
    if (/check|violat|length/i.test(error.message)) {
      return { ok: false, error: "A fact needs 8 to 300 characters. Describe it in a full phrase." };
    }
    return { ok: false, error: `Could not add: ${error.message}` };
  }

  revalidatePath("/benchmarks");
  return { ok: true };
}

const wantedStatusSchema = z.object({
  wanted_fact_id: z.string().uuid(),
  status: z.enum(["dismissed", "open"]),
});

// "Don't look for this" works from any live state; "Look again" only from the two
// states where research has stopped.
const FROM_STATES = {
  dismissed: ["open", "proposed", "no_source"],
  open: ["dismissed", "no_source"],
} as const;

export async function setWantedFactStatus(
  input: z.input<typeof wantedStatusSchema>,
): Promise<BenchmarkActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot change benchmarks." };
  }

  const parsed = wantedStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("wanted_facts")
    .update({ status: parsed.data.status })
    .eq("id", parsed.data.wanted_fact_id)
    .eq("tenant_id", user.tenantId)
    .in("status", [...FROM_STATES[parsed.data.status]])
    .select("id");

  if (error) return { ok: false, error: `Could not update: ${error.message}` };
  if (!data || data.length === 0) {
    return { ok: false, error: "That fact changed in the meantime. Reload the page." };
  }

  revalidatePath("/benchmarks");
  return { ok: true };
}
