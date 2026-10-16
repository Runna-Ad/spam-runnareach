import { createServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * Canonical action codes. Keep these stable — they show up in the activity
 * feed and any future analytics over the audit log. Format:
 *   <entity>.<verb>
 */
export type AuditAction =
  | "prospect.created"
  | "prospect.updated"
  | "prospect.status_changed"
  | "prospect.scraped"
  | "prospect.scored"
  | "prospect.deleted"
  | "research.edited"
  | "research.created"
  | "pitch.sent"
  | "reply.intent_handled"
  | "reply.imported"
  | "reply.drafted"
  | "reply.sent"
  | "reply.nudge_sent"
  | "reply.nudge_held"
  | "prospect.archived_no_meeting"
  // Opt-out from the unsubscribe link, one-click header, or an opt-out reply.
  | "prospect.opted_out"
  // Pre-send verification gate, dry-run mode: records what the gate WOULD have
  // decided about a generated pitch. Changes nothing — it exists to prove the
  // gate agrees with human judgement before it's allowed to block a send.
  | "pitch.gate_dryrun";

export type AuditPayload = {
  tenantId: string;
  actorId: string | null;
  action: AuditAction;
  entityType: "prospect" | "research" | "icp" | "case_study" | "pitch" | "reply";
  entityId: string;
  metadata?: Record<string, unknown>;
};

/**
 * Best-effort audit log write. Never throws — audit failures must not block
 * the user's primary action (the alternative is "your save succeeded but
 * we couldn't log it, so we rolled back" which is worse than a missing
 * audit entry).
 *
 * Service-role client with the caller's explicit tenantId. The cookie client
 * used before only worked inside a logged-in request, so every audit write
 * from a cron (nudge sent/held, etc.) was silently rejected by RLS.
 */
export async function writeAuditLog(p: AuditPayload): Promise<void> {
  try {
    const supabase = createServiceRoleClient();
    const { error } = await supabase.from("audit_log").insert({
      tenant_id: p.tenantId,
      actor_id: p.actorId,
      action: p.action,
      entity_type: p.entityType,
      entity_id: p.entityId,
      metadata: p.metadata ?? {},
    });
    if (error) {
      // Surface to logs but don't propagate.
      console.warn(`[audit] insert failed: ${error.message}`, {
        action: p.action,
        entity: `${p.entityType}:${p.entityId}`,
      });
    }
  } catch (err) {
    console.warn("[audit] write threw:", err);
  }
}
