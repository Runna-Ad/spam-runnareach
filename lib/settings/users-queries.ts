import { createClient } from "@/lib/supabase/server";

export type UserRole = "admin" | "reviewer" | "viewer";

export type Member = {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: UserRole;
  last_seen_at: string | null;
  created_at: string;
  invited_by: string | null;
};

export type PendingInvitation = {
  id: string;
  email: string;
  role: UserRole;
  token: string;
  invited_by_name: string | null;
  expires_at: string;
  created_at: string;
};

export async function listMembers(tenantId: string): Promise<Member[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("users")
    .select("id, email, full_name, avatar_url, role, last_seen_at, created_at, invited_by")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
    .returns<Member[]>();

  if (error) throw new Error(`Failed to load members: ${error.message}`);
  return data ?? [];
}

export async function listPendingInvitations(tenantId: string): Promise<PendingInvitation[]> {
  const supabase = await createClient();

  type Row = {
    id: string;
    email: string;
    role: UserRole;
    token: string;
    expires_at: string;
    created_at: string;
    users: { full_name: string | null } | null;
  };

  const { data, error } = await supabase
    .from("invitations")
    .select("id, email, role, token, expires_at, created_at, users(full_name)")
    .eq("tenant_id", tenantId)
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .returns<Row[]>();

  if (error) throw new Error(`Failed to load invitations: ${error.message}`);
  if (!data) return [];

  return data.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    token: r.token,
    invited_by_name: r.users?.full_name ?? null,
    expires_at: r.expires_at,
    created_at: r.created_at,
  }));
}
