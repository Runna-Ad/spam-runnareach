import { createClient } from "@/lib/supabase/server";

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
  | "research.edited"
  | "research.created"
  | "pitch.sent";

export type AuditPayload = {
  tenantId: string;
  actorId: string | null;
  action: AuditAction;
  entityType: "prospect" | "research" | "icp" | "case_study" | "pitch";
  entityId: string;
  metadata?: Record<string, unknown>;
};

/**
 * Best-effort audit log write. Never throws — audit failures must not block
 * the user's primary action (the alternative is "your save succeeded but
 * we couldn't log it, so we rolled back" which is worse than a missing
 * audit entry).
 *
 * RLS on audit_log enforces tenant_id = current_tenant_id() so the row
 * is automatically tagged correctly.
 */
export async function writeAuditLog(p: AuditPayload): Promise<void> {
  try {
    const supabase = await createClient();
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
