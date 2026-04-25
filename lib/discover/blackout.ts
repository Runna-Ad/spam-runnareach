import { createClient } from "@/lib/supabase/server";

export type Market = "CA" | "MX" | "US" | "LATAM";

export type BlackoutDate = {
  id: string;
  market: Market;
  blackout_date: string; // YYYY-MM-DD
  label: string;
};

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

/**
 * Pure helper used by the send queue (Phase 4) and the discovery cron
 * (Phase 1b) — given a list of blackout dates and a target Date, returns
 * the matching label or null.
 */
export function blackoutLabel(
  date: Date,
  blackouts: Pick<BlackoutDate, "blackout_date" | "label">[],
): string | null {
  const ymd = date.toISOString().slice(0, 10);
  const hit = blackouts.find((b) => b.blackout_date === ymd);
  return hit?.label ?? null;
}
