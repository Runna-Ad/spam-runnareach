/**
 * The opt_out_spike breaker's numbers, read from the database. The rule itself
 * stays pure in governor.ts (evaluateBreakers); this file only decides what
 * counts: PEOPLE who opted out, not timeline events.
 *
 * One "remove me" reply writes two events: the reply poll records a `reply`
 * (intent hard_no) on the thread's pitch, and recordOptOut records an
 * `unsubscribe` on the prospect's root pitch, often a different pitch id. A link
 * click writes only the `unsubscribe`. Counting rows made one person count
 * twice, so two opt-outs in a week paused every inbox and demoted the stage.
 * Here a person is a prospect, reached through pitch_events.pitch_id →
 * pitches.prospect_id (pitch_events has no prospect column).
 *
 * Fails toward the old behaviour: when a read fails (or hits its limit), that
 * window uses the old event count, and the error is reported. Never 0 from an
 * error.
 *
 * The db is injected so this is tested with a fake (tests/optout-alarm-people.test.ts).
 */

// Untyped like tick.ts: pitch_events queries go through any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

const DAY = 86_400_000;

/**
 * Bound on each read. The 30-day window holds a handful of opt-outs (0 in prod
 * on 2026-10-20; ~20 sends a day). Reaching the bound means the count may be
 * short, so the window falls back to the event count instead.
 */
export const OPT_OUT_READ_LIMIT = 1000;

export type OptOutMetrics = {
  optOutsThisWeek: number;
  optOutWeeklyBaseline: number;
  errors: string[];
};

type EventRow = { pitch_id: string; event_at: string };

/** The old count: opt-out events (unsubscribe + hard_no replies) since a time. */
async function countOptOutEvents(db: Db, tenantId: string, sinceIso: string): Promise<{ count: number; error: string | null }> {
  const one = async (type: string, intent?: string) => {
    let q = db
      .from("pitch_events")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("event_type", type)
      .gte("event_at", sinceIso);
    if (intent) q = q.eq("payload->>intent", intent);
    const { count, error } = await q;
    // A count is an HTTP HEAD: a failure has no body, so postgrest-js reports { message: "" }.
    return { count: (count as number | null) ?? 0, error: error ? String(error.message || "read failed") : null };
  };
  const [unsub, hardNo] = await Promise.all([one("unsubscribe"), one("reply", "hard_no")]);
  return { count: unsub.count + hardNo.count, error: unsub.error !== null ? unsub.error : hardNo.error };
}

/** Distinct prospects with an opt-out event since `monthIso`, split at `weekIso`. Throws on a failed or truncated read. */
async function countOptOutPeople(db: Db, tenantId: string, monthIso: string, weekIso: string): Promise<{ week: number; month: number }> {
  // Only pitch_id + event_at, bounded: see OPT_OUT_READ_LIMIT.
  const read = async (type: string, intent?: string): Promise<EventRow[]> => {
    let q = db
      .from("pitch_events")
      .select("pitch_id, event_at")
      .eq("tenant_id", tenantId)
      .eq("event_type", type)
      .gte("event_at", monthIso);
    if (intent) q = q.eq("payload->>intent", intent);
    const { data, error } = await q.limit(OPT_OUT_READ_LIMIT);
    if (error) throw new Error(`pitch_events ${type}: ${error.message || "read failed"}`);
    const rows = (data ?? []) as EventRow[];
    if (rows.length >= OPT_OUT_READ_LIMIT) throw new Error(`pitch_events ${type}: ${rows.length} rows hit the read limit`);
    return rows;
  };
  const events = [...(await read("unsubscribe")), ...(await read("reply", "hard_no"))];
  if (events.length === 0) return { week: 0, month: 0 };

  const pitchIds = [...new Set(events.map((e) => e.pitch_id))];
  const { data, error } = await db
    .from("pitches")
    .select("id, prospect_id")
    .eq("tenant_id", tenantId)
    .in("id", pitchIds)
    .limit(OPT_OUT_READ_LIMIT);
  if (error) throw new Error(`pitches: ${error.message || "read failed"}`);
  const prospectOf = new Map(((data ?? []) as Array<{ id: string; prospect_id: string }>).map((p) => [p.id, p.prospect_id]));

  // A pitch the lookup didn't return counts as its own person: counting more trips sooner, never later.
  const person = (e: EventRow) => prospectOf.get(e.pitch_id) ?? `pitch:${e.pitch_id}`;
  const weekStart = Date.parse(weekIso);
  const month = new Set(events.map(person));
  const week = new Set(events.filter((e) => Date.parse(e.event_at) >= weekStart).map(person));
  return { week: week.size, month: month.size };
}

/**
 * optOutsThisWeek = people who opted out in the last 7 days; the baseline is
 * the last 30 days' people scaled to a week, the same formula as before.
 */
export async function optOutMetrics(db: Db, tenantId: string, now: Date): Promise<OptOutMetrics> {
  const weekIso = new Date(now.getTime() - 7 * DAY).toISOString();
  const monthIso = new Date(now.getTime() - 30 * DAY).toISOString();
  const errors: string[] = [];
  let week: number;
  let month: number;
  try {
    ({ week, month } = await countOptOutPeople(db, tenantId, monthIso, weekIso));
  } catch (err) {
    const [w, m] = await Promise.all([countOptOutEvents(db, tenantId, weekIso), countOptOutEvents(db, tenantId, monthIso)]);
    const fallbackFailed = w.error !== null || m.error !== null;
    errors.push(
      `opt-out people count failed (${(err as Error).message}); ` +
        (fallbackFailed ? "the event-count fallback failed too, so the opt-out alarm ran on incomplete counts" : "using the event count"),
    );
    if (w.error !== null) errors.push(`opt-out event count (7 days) failed: ${w.error}`);
    if (m.error !== null) errors.push(`opt-out event count (30 days) failed: ${m.error}`);
    week = w.count;
    month = m.count;
  }
  return { optOutsThisWeek: week, optOutWeeklyBaseline: (month / 30) * 7, errors };
}
