// Hot-lead events for a page of pitches. Kept apart from queries.ts (which needs
// the Next server client) so the failure path can be tested with a fake client.
import type { HotLeadEvent } from "./hot-lead.ts";

type EventsClient = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        in(column: string, values: string[]): PromiseLike<{
          data: unknown[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

export type HotLeadEventsResult = {
  eventsByPitch: Map<string, HotLeadEvent[]>;
  /** True when the pitch_events lookup failed; the badges are then unknown, not absent. */
  unavailable: boolean;
};

/** One query for every audit_scan event of `ids` (no N+1). Never throws on a query error. */
export async function loadHotLeadEvents(
  client: EventsClient,
  ids: string[],
): Promise<HotLeadEventsResult> {
  const eventsByPitch = new Map<string, HotLeadEvent[]>();
  if (ids.length === 0) return { eventsByPitch, unavailable: false };
  const { data, error } = await client
    .from("pitch_events")
    .select("pitch_id, event_type, payload, event_at")
    .eq("event_type", "audit_scan")
    .in("pitch_id", ids);
  if (error) {
    console.warn("[pitches] hot-lead events not loaded:", error.message);
    return { eventsByPitch, unavailable: true };
  }
  for (const e of (data ?? []) as (HotLeadEvent & { pitch_id: string })[]) {
    const list = eventsByPitch.get(e.pitch_id);
    if (list) list.push(e);
    else eventsByPitch.set(e.pitch_id, [e]);
  }
  return { eventsByPitch, unavailable: false };
}
