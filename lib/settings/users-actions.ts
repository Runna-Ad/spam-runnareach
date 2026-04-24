"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

const roleEnum = z.enum(["admin", "reviewer", "viewer"]);
const emailSchema = z.string().trim().email().max(200);

const RUNNA_DOMAINS = ["runna.com.mx", "runna.agency", "runnareach.com"];
const EMAIL_EXCEPTIONS = new Set<string>(["petedv31@gmail.com"]);

function isAllowedEmail(raw: string): boolean {
  const email = raw.trim().toLowerCase();
  if (EMAIL_EXCEPTIONS.has(email)) return true;
  const domain = email.split("@")[1];
  return Boolean(domain && RUNNA_DOMAINS.includes(domain));
}

export type InviteResult =
  | { ok: true; id: string; token: string }
  | { ok: false; error: string };

export type UserActionResult =
  | { ok: true }
  | { ok: false; error: string };

export async function inviteTeammate(input: {
  email: string;
  role: "admin" | "reviewer" | "viewer";
}): Promise<InviteResult> {
  const user = await requireUser();
  if (user.role !== "admin") return { ok: false, error: "Only admins can invite teammates." };

  const parsed = z
    .object({ email: emailSchema, role: roleEnum })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const email = parsed.data.email.toLowerCase();

  if (!isAllowedEmail(email)) {
    return {
      ok: false,
      error: `Invites restricted to Runna emails (${RUNNA_DOMAINS.join(", ")}).`,
    };
  }

  const admin = createServiceRoleClient();

  // Reject if the email already has a public.users row in this tenant.
  const { data: existingUser } = await admin
    .from("users")
    .select("id")
    .eq("tenant_id", user.tenantId)
    .eq("email", email)
    .maybeSingle<{ id: string }>();

  if (existingUser) {
    return { ok: false, error: "That email is already a member of this tenant." };
  }

  const token = randomBytes(24).toString("base64url");

  const payload = {
    tenant_id: user.tenantId,
    email,
    role: parsed.data.role,
    token,
    invited_by: user.id,
  };

  const { data, error } = await admin
    .from("invitations")
    .insert(payload as never)
    .select("id")
    .single<{ id: string }>();

  if (error) return { ok: false, error: `Could not create invitation: ${error.message}` };
  if (!data) return { ok: false, error: "Invitation insert returned no row." };

  revalidatePath("/settings/users");
  return { ok: true, id: data.id, token };
}

export async function revokeInvitation(id: string): Promise<UserActionResult> {
  const user = await requireUser();
  if (user.role !== "admin") return { ok: false, error: "Only admins can revoke invitations." };

  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: "Invalid invitation id." };

  const supabase = await createClient();

  const { error } = await supabase
    .from("invitations")
    .delete()
    .eq("id", parsed.data)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not revoke invitation: ${error.message}` };

  revalidatePath("/settings/users");
  return { ok: true };
}

export async function changeMemberRole(input: {
  userId: string;
  role: "admin" | "reviewer" | "viewer";
}): Promise<UserActionResult> {
  const user = await requireUser();
  if (user.role !== "admin") return { ok: false, error: "Only admins can change roles." };

  const parsed = z
    .object({ userId: z.string().uuid(), role: roleEnum })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  // Self-protection: prevent the current admin from demoting themselves if
  // they're the only admin left. This avoids a zero-admin lockout.
  if (parsed.data.userId === user.id && parsed.data.role !== "admin") {
    const admin = createServiceRoleClient();
    const { count, error: countErr } = await admin
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", user.tenantId)
      .eq("role", "admin");
    if (countErr) return { ok: false, error: `Could not verify admin count: ${countErr.message}` };
    if ((count ?? 0) <= 1) {
      return {
        ok: false,
        error: "Cannot demote yourself — you're the last admin. Promote someone else first.",
      };
    }
  }

  const supabase = await createClient();

  const { error } = await supabase
    .from("users")
    .update({ role: parsed.data.role, updated_at: new Date().toISOString() } as never)
    .eq("id", parsed.data.userId)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not change role: ${error.message}` };

  revalidatePath("/settings/users");
  return { ok: true };
}

export async function removeMember(userId: string): Promise<UserActionResult> {
  const user = await requireUser();
  if (user.role !== "admin") return { ok: false, error: "Only admins can remove members." };

  const parsed = z.string().uuid().safeParse(userId);
  if (!parsed.success) return { ok: false, error: "Invalid user id." };

  if (parsed.data === user.id) {
    return { ok: false, error: "Cannot remove yourself. Ask another admin." };
  }

  const admin = createServiceRoleClient();

  // Enforce last-admin protection: don't remove the last admin.
  const { data: target } = await admin
    .from("users")
    .select("role")
    .eq("id", parsed.data)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<{ role: "admin" | "reviewer" | "viewer" }>();

  if (target?.role === "admin") {
    const { count } = await admin
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", user.tenantId)
      .eq("role", "admin");
    if ((count ?? 0) <= 1) {
      return {
        ok: false,
        error: "Cannot remove the last admin. Promote another member first.",
      };
    }
  }

  // Delete the public.users row first, then the auth user. If the auth delete
  // fails, the users row is already gone — that's safer than leaving an
  // orphaned profile that still appears in the members list.
  const { error: profileErr } = await admin
    .from("users")
    .delete()
    .eq("id", parsed.data)
    .eq("tenant_id", user.tenantId);

  if (profileErr) return { ok: false, error: `Could not remove member: ${profileErr.message}` };

  const { error: authErr } = await admin.auth.admin.deleteUser(parsed.data);
  if (authErr) {
    // Non-fatal — profile is gone, auth record will be cleaned up on next
    // nightly sweep. Surface a warning.
    return {
      ok: false,
      error: `Member profile removed but auth user lingered: ${authErr.message}. Retry or clean up manually.`,
    };
  }

  revalidatePath("/settings/users");
  return { ok: true };
}
