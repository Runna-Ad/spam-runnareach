"use server";

import { redirect } from "next/navigation";
import { createClient } from "./server";
import { createServiceRoleClient } from "./service-role";

/** Bootstrap tenant ID for single-tenant launch. Hard-coded from seed.sql. */
const RUNNA_CA_TENANT_ID = "11111111-1111-1111-1111-111111111111";

/**
 * Email domain allowlist for auth. Accounts must belong to one of these
 * Runna-owned domains. Extend here when new domains come online.
 */
const ALLOWED_EMAIL_DOMAINS = [
  "runna.com.mx", // Rünna Mexico (parent)
  "runna.agency", // Runna CA primary brand domain
  "runnareach.com", // Runna CA outreach / engine-sender domain
] as const;

/**
 * Individual email addresses allowed as a one-off exception to the domain
 * list. Use sparingly — real teammates should get runna.com.mx / runna.agency
 * mailboxes via Google Workspace. This is Pedro's personal email so he can
 * exercise the app while the Workspace domains are still being set up.
 */
const ALLOWED_EMAIL_EXCEPTIONS = new Set<string>(["petedv31@gmail.com"]);

function isAllowedEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  if (ALLOWED_EMAIL_EXCEPTIONS.has(normalized)) return true;
  const domain = normalized.split("@")[1];
  if (!domain) return false;
  return ALLOWED_EMAIL_DOMAINS.includes(domain as (typeof ALLOWED_EMAIL_DOMAINS)[number]);
}

export type AuthActionResult = { error: string } | { success: true } | null;

/**
 * Sign in with email + password. useActionState-compatible signature.
 */
export async function signInAction(
  _prev: AuthActionResult,
  formData: FormData,
): Promise<AuthActionResult> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  if (!isAllowedEmail(email)) {
    return {
      error: `Access restricted to Runna emails (${ALLOWED_EMAIL_DOMAINS.join(", ")}).`,
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: error.message };
  }

  redirect("/dashboard");
}

/**
 * Sign up + auto-provision a public.users row tied to the RUNNA_CA tenant.
 * First user to sign up becomes admin. Subsequent signups without an invite
 * become reviewers by default — tighten this before production (invite-gated).
 */
export async function signUpAction(
  _prev: AuthActionResult,
  formData: FormData,
): Promise<AuthActionResult> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const fullName = String(formData.get("fullName") ?? "").trim();

  if (!email || !password || !fullName) {
    return { error: "Name, email, and password are required." };
  }

  if (!isAllowedEmail(email)) {
    return {
      error: `Sign-up restricted to Runna emails (${ALLOWED_EMAIL_DOMAINS.join(", ")}).`,
    };
  }

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  // Create the auth user via service role with email auto-confirmed. This
  // bypasses Supabase's default "confirm email" link flow — appropriate
  // for this invite-only internal tool where the domain allowlist + admin
  // approval already gate access. Re-enable the confirmation flow in
  // Phase 6 if we ever open sign-up to a broader audience.
  const admin = createServiceRoleClient();

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (createError) {
    return { error: createError.message };
  }

  if (!created.user) {
    return { error: "Sign up did not return a user." };
  }

  const { count: existingUserCount, error: countError } = await admin
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", RUNNA_CA_TENANT_ID);

  if (countError) {
    return { error: `Could not verify tenant state: ${countError.message}` };
  }

  const role = (existingUserCount ?? 0) === 0 ? "admin" : "reviewer";

  const { error: insertError } = await admin.from("users").insert({
    id: created.user.id,
    tenant_id: RUNNA_CA_TENANT_ID,
    email,
    full_name: fullName,
    role,
  });

  if (insertError) {
    return { error: `Could not create user profile: ${insertError.message}` };
  }

  // Sign the new user in so the browser gets a session cookie before
  // middleware runs on the post-redirect /dashboard request.
  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

  if (signInError) {
    return { error: `Account created but sign-in failed: ${signInError.message}` };
  }

  redirect("/dashboard");
}

/**
 * Sign out + redirect to sign-in.
 */
export async function signOutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/sign-in");
}
