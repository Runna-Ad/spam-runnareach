import { createClient } from "@/lib/supabase/server";

// Re-export pure helpers so existing import sites keep working. The pure
// types/functions live in blackout-pure.ts so tests + non-server code can
// import them without dragging next/headers into the bundle.
export { blackoutLabel } from "./blackout-pure";
export type { BlackoutDate, Market } from "./blackout-pure";

import type { BlackoutDate, Market } from "./blackout-pure";

/**
 * List blackout dates for a tenant + market (or all markets if omitted).
 * Includes seeded CA stat holidays.
 */
export async function listBlackouts(tenantId: string, market?: Market): Promise<BlackoutDate[]> {
  const supabase = await createClient();
  let query = supabase
    .from("blackout_dates")
    .select("id, market, blackout_date, label")
    .eq("tenant_id", tenantId)
    .order("blackout_date", { ascending: true });
  if (market) query = query.eq("market", market);

  const { data, error } = await query.returns<BlackoutDate[]>();
  if (error) throw new Error(`Failed to load blackouts: ${error.message}`);
  return data ?? [];
}
