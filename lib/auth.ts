import { redirect } from "next/navigation";
import { createClient } from "./supabase/server";

export type CurrentUser = {
  id: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  role: "admin" | "reviewer" | "viewer";
  tenantId: string;
  tenantDisplayName: string;
};

/**
 * Load the authenticated user's profile joined with their tenant.
 * Returns null if not signed in or no public.users row exists yet.
 *
 * Use in Server Components + Route Handlers. For guarded pages that require
 * an authenticated user, prefer `requireUser()` below.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createClient();

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) return null;

  const { data: profile } = await supabase
    .from("users")
    .select("id, email, full_name, avatar_url, role, tenant_id, tenants(display_name)")
    .eq("id", authUser.id)
    .single<{
      id: string;
      email: string;
      full_name: string | null;
      avatar_url: string | null;
      role: "admin" | "reviewer" | "viewer";
      tenant_id: string;
      tenants: { display_name: string } | null;
    }>();

  if (!profile) return null;

  return {
    id: profile.id,
    email: profile.email,
    fullName: profile.full_name,
    avatarUrl: profile.avatar_url,
    role: profile.role,
    tenantId: profile.tenant_id,
    tenantDisplayName: profile.tenants?.display_name ?? "—",
  };
}

/**
 * Require an authenticated user — redirects to /sign-in if not.
 * Use in Server Components that render protected dashboard pages.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return user;
}
