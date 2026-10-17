// Hot-lead level of a pitch, derived from its audit_scan events (written by
// the 0039 trigger when a prospect runs the audit tool from the pitch's link,
// then submits the contact form). Pure: callers fetch the events.

export type HotLeadLevel = "contact_request" | "scan";

export type HotLeadEvent = {
  event_type: string;
  event_at: string;
  payload: unknown;
};

export type HotLead = { level: HotLeadLevel; at: string };

function levelOf(e: HotLeadEvent): HotLeadLevel | null {
  if (e.event_type !== "audit_scan") return null;
  const stage = (e.payload as { stage?: unknown } | null)?.stage;
  if (stage === "contact_request") return "contact_request";
  if (stage === "scan") return "scan";
  return null;
}

/**
 * `contact_request` beats `scan`. `at` is the latest event_at among the events
 * of the winning level. No qualifying events → null.
 */
export function hotLeadLevel(events: readonly HotLeadEvent[]): HotLead | null {
  let best: HotLead | null = null;
  for (const e of events) {
    const level = levelOf(e);
    if (!level) continue;
    const t = Date.parse(e.event_at);
    if (Number.isNaN(t)) continue;
    if (
      !best ||
      (level === "contact_request" && best.level === "scan") ||
      (level === best.level && t > Date.parse(best.at))
    ) {
      best = { level, at: e.event_at };
    }
  }
  return best;
}
