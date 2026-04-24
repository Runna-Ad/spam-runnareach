"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

type InvitationRow = {
  id: string;
  tenant_id: string;
  email: string;
  role: "admin" | "reviewer" | "viewer";
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
};

export type AcceptInviteState = { error: string } | null;

const acceptSchema = z.object({
  token: z.string().min(1).max(200),
  full_name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
});

/**
 * Server Action for an unauthenticated visitor accepting an invitation by
 * supplying a name + password. Creates the Supabase auth user + the
 * public.users row in one shot, marks the invitation accepted, and signs the
 * new user in so the post-redirect /dashboard request carries a session.
 */
export async function acceptInviteAsNewUser(
  _prev: AcceptInviteState,
  formData: FormData,
): Promise<AcceptInviteState> {
  const parsed = acceptSchema.safeParse({
    token: String(formData.get("token") ?? ""),
    full_name: String(formData.get("full_name") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const admin = createServiceRoleClient();
  const invitation = await loadInvitation(admin, parsed.data.token);
  if ("error" in invitation) return invitation;

  const { data: existing } = await admin.auth.admin.listUsers();
  const already = existing.users.find((u) => u.email?.toLowerCase() === invitation.email);
  if (already) {
    return {
      error: "An account already exists for this email. Sign in first, then re-open the invite link.",
    };
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: invitation.email,
    password: parsed.data.password,
    email_confirm: true,
    user_metadata: { full_name: parsed.data.full_name },
  });
  if (createErr || !created.user) {
    return { error: `Could not create account: ${createErr?.message ?? "no user returned"}` };
  }

  const { error: profileErr } = await admin.from("users").insert({
    id: created.user.id,
    tenant_id: invitation.tenant_id,
    email: invitation.email,
    full_name: parsed.data.full_name,
    role: invitation.role,
    invited_by: invitation.invited_by,
    invited_at: new Date().toISOString(),
  } as never);

  if (profileErr) {
    // Roll back auth user so the invitation can be retried.
    await admin.auth.admin.deleteUser(created.user.id);
    return { error: `Could not create profile: ${profileErr.message}` };
  }

  await admin
    .from("invitations")
    .update({ accepted_at: new Date().toISOString() } as never)
    .eq("id", invitation.id);

  const supabase = await createClient();
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email: invitation.email,
    password: parsed.data.password,
  });
  if (signInErr) {
    return { error: `Account created but sign-in failed: ${signInErr.message}` };
  }

  redirect("/dashboard");
}

/**
 * Called from the server-component when the visitor is already signed in but
 * their public.users row either doesn't exist or is in a different tenant —
 * attach them to the tenant specified by the invitation.
 */
export async function acceptInviteAsCurrentUser(token: string): Promise<AcceptInviteState> {
  const parsed = z.string().min(1).max(200).safeParse(token);
  if (!parsed.success) return { error: "Invalid invitation token." };

  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return { error: "You need to be signed in to accept this way." };

  const admin = createServiceRoleClient();
  const invitation = await loadInvitation(admin, parsed.data);
  if ("error" in invitation) return invitation;

  if (authUser.email?.toLowerCase() !== invitation.email) {
    return {
      error: `You're signed in as ${authUser.email}. This invite is for ${invitation.email}.`,
    };
  }

  const { data: existingProfile } = await admin
    .from("users")
    .select("id, tenant_id")
    .eq("id", authUser.id)
    .maybeSingle<{ id: string; tenant_id: string }>();

  if (existingProfile && existingProfile.tenant_id === invitation.tenant_id) {
    // Already a member — just mark accepted.
    await admin
      .from("invitations")
      .update({ accepted_at: new Date().toISOString() } as never)
      .eq("id", invitation.id);
    redirect("/dashboard");
  }

  if (existingProfile) {
    return { error: "Your account is already in another tenant — contact an admin." };
  }

  const { error: insertErr } = await admin.from("users").insert({
    id: authUser.id,
    tenant_id: invitation.tenant_id,
    email: invitation.email,
    full_name: authUser.user_metadata?.full_name ?? null,
    role: invitation.role,
    invited_by: invitation.invited_by,
    invited_at: new Date().toISOString(),
  } as never);
  if (insertErr) return { error: `Could not create profile: ${insertErr.message}` };

  await admin
    .from("invitations")
    .update({ accepted_at: new Date().toISOString() } as never)
    .eq("id", invitation.id);

  redirect("/dashboard");
}

async function loadInvitation(
  admin: ReturnType<typeof createServiceRoleClient>,
  token: string,
): Promise<InvitationRow | { error: string }> {
  const { data, error } = await admin
    .from("invitations")
    .select("id, tenant_id, email, role, invited_by, expires_at, accepted_at")
    .eq("token", token)
    .maybeSingle<InvitationRow>();

  if (error) return { error: `Could not load invitation: ${error.message}` };
  if (!data) return { error: "Invitation not found. The link may be wrong or revoked." };
  if (data.accepted_at) return { error: "This invitation was already accepted." };
  if (new Date(data.expires_at) < new Date()) return { error: "This invitation has expired." };

  return data;
}
