import { createClient } from "@/lib/supabase/server";
import type { ArmRow, ArmStatus } from "./report";

// learning_arms isn't in the hand-written Supabase types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

const STATUSES: ArmStatus[] = ["champion", "challenger", "retired"];

/** Read-only: every arm for the tenant. Nothing in the UI writes to this table. */
export async function listLearningArms(tenantId: string): Promise<ArmRow[]> {
  const supabase: AnySupabase = await createClient();
  const { data, error } = await supabase
    .from("learning_arms")
    .select("learner, key, status, origin, reward, trials, negatives, updated_at")
    .eq("tenant_id", tenantId)
    .limit(2000);
  if (error) {
    console.warn("[learning] arms not loaded:", error.message);
    return [];
  }
  return ((data ?? []) as ArmRow[]).filter((r) => STATUSES.includes(r.status));
}
