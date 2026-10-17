// Pitch lifecycle events — append-only rows in pitch_events.
//
// The decision record (pitches.decision) says what was decided when a pitch
// was written; these rows say what happened to it afterwards: approved, held
// by the gate, sent (to whom, verified how, edited how much), replied to,
// bounced, opted out. Together they are what a learning loop can read, and
// nothing is ever overwritten (unlike pitches.status or sequence_step).
//
// Best-effort by design: an event is evidence, not a dependency. A failed
// insert is logged and swallowed so it can never block a send or a reply.

// The cookie client (server actions) and the service-role client (crons) have
// different generated types; pitch_events isn't in the hand-written types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

export type PitchEventType =
  | "generated"
  | "approved"
  | "gate_held"
  | "sent"
  | "reply"
  | "bounce"
  | "unsubscribe"
  | "audit_scan"
  | "meeting_booked"
  | "won"
  | "lost";

export async function recordPitchEvent(
  supabase: AnySupabase,
  event: {
    tenantId: string;
    pitchId: string;
    type: PitchEventType;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { error } = await supabase.from("pitch_events").insert({
      tenant_id: event.tenantId,
      pitch_id: event.pitchId,
      event_type: event.type,
      payload: event.payload ?? {},
    });
    if (error) console.warn(`[pitch-events] ${event.type} not recorded:`, error.message);
  } catch (err) {
    console.warn(`[pitch-events] ${event.type} not recorded:`, (err as Error).message);
  }
}
