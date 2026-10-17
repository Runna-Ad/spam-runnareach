import "server-only";

/**
 * Who a pipeline stage acts for, passed explicitly.
 *
 * The stages (discover → scrape → research → score → triage → pitch) used to
 * call requireUser() and the cookie Supabase client themselves, so they could
 * only run inside a logged-in browser request. Each stage now takes an Actor:
 *
 *   sessionActor()       the logged-in user + the cookie client (RLS applies).
 *                        What every browser-facing server action uses.
 *   systemActorFor(t)    the tenant's autopilot identity + the service-role
 *                        client. ONLY for requests that proved the cron secret
 *                        (`isCronAuthorized`); never reachable from a browser.
 *
 * Stages that accept an Actor live in plain modules (*-stage.ts), not "use
 * server" files: every export of a "use server" file is callable from the
 * browser with any arguments, so an actor parameter there would let a caller
 * claim to be anyone. The "use server" wrappers take no actor; they build one
 * from the session.
 *
 * The system actor bypasses RLS, so stages must keep filtering by
 * actor.user.tenantId explicitly (they already do).
 */

import { requireUser, type CurrentUser } from "./auth";
import { isCronAuthorized } from "./cron-auth";
// The worker chain authenticates with CRON_SECRET (systemAuthHeaders); only
// app-internal calls build a system actor.
import { createClient } from "./supabase/server";
import { createServiceRoleClient } from "./supabase/service-role";

type SessionClient = Awaited<ReturnType<typeof createClient>>;

export type Actor = {
  user: CurrentUser;
  supabase: SessionClient;
  /** True for the autopilot (service role, no session). */
  system: boolean;
};

export const AUTOPILOT_NAME = "Autopilot";
/** Header naming the tenant a system request acts for (honored only with the cron secret). */
export const TENANT_HEADER = "x-autopilot-tenant";

/** The logged-in user. Redirects to /sign-in without a session, like requireUser(). */
export async function sessionActor(): Promise<Actor> {
  const user = await requireUser();
  return { user, supabase: await createClient(), system: false };
}

export { isCronAuthorized };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The tenant's autopilot: acts as its first admin (so created_by / actor_id
 * foreign keys hold) under the name "Autopilot", with the service-role client.
 * Call only after isCronAuthorized(). Null if the tenant has no admin.
 */
export async function systemActorFor(tenantId: string): Promise<Actor | null> {
  if (!UUID_RE.test(tenantId)) return null;
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("users")
    .select("id, email, avatar_url, tenant_id, tenants(display_name)")
    .eq("tenant_id", tenantId)
    .eq("role", "admin")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<{
      id: string;
      email: string;
      avatar_url: string | null;
      tenant_id: string;
      tenants: { display_name: string } | null;
    }>();
  if (!data) return null;
  return {
    user: {
      id: data.id,
      email: data.email,
      fullName: AUTOPILOT_NAME,
      avatarUrl: data.avatar_url,
      role: "admin",
      tenantId: data.tenant_id,
      tenantDisplayName: data.tenants?.display_name ?? "—",
    },
    supabase: supabase as unknown as SessionClient,
    system: true,
  };
}

/** A request carrying the cron secret and a tenant header → that tenant's system actor. */
export async function systemActorFromRequest(req: Request): Promise<Actor | null> {
  if (!isCronAuthorized(req)) return null;
  const tenantId = req.headers.get(TENANT_HEADER);
  return tenantId ? systemActorFor(tenantId) : null;
}

/** Headers that let a server-to-server call act as a tenant's system actor. */
export function systemAuthHeaders(tenantId: string): Record<string, string> {
  return {
    authorization: `Bearer ${process.env.CRON_SECRET ?? ""}`,
    [TENANT_HEADER]: tenantId,
  };
}
