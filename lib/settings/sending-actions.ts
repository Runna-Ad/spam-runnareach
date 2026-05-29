"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const createSchema = z.object({
  brand_instance_id: z.string().uuid(),
  email: z.string().trim().email().max(200),
  display_name: z.string().trim().min(1).max(120),
  linkedin_url: z.string().trim().max(500).nullable(),
  daily_cap: z.number().int().min(1).max(500),
});

const updateSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string().trim().min(1).max(120),
  linkedin_url: z.string().trim().max(500).nullable(),
  daily_cap: z.number().int().min(1).max(500),
  paused: z.boolean(),
  paused_reason: z.string().trim().max(500).nullable(),
});

export type CreateSenderInboxInput = z.input<typeof createSchema>;
export type UpdateSenderInboxInput = z.input<typeof updateSchema>;

export type SenderActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

function ensureAdmin(role: "admin" | "reviewer" | "viewer"): string | null {
  if (role === "admin") return null;
  return "Only admins can manage sender inboxes.";
}

export async function createSenderInbox(input: CreateSenderInboxInput): Promise<SenderActionResult> {
  const user = await requireUser();
  const roleErr = ensureAdmin(user.role);
  if (roleErr) return { ok: false, error: roleErr };

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();

  const payload = {
    tenant_id: user.tenantId,
    brand_instance_id: parsed.data.brand_instance_id,
    user_id: user.id,
    email: parsed.data.email.toLowerCase(),
    display_name: parsed.data.display_name,
    linkedin_url: parsed.data.linkedin_url,
    daily_cap: parsed.data.daily_cap,
    paused: false,
  };

  const { data, error } = await supabase
    .from("sender_inboxes")
    .insert(payload)
    .select("id")
    .single<{ id: string }>();

  if (error) return { ok: false, error: `Could not create sender inbox: ${error.message}` };
  if (!data) return { ok: false, error: "Insert returned no row." };

  revalidatePath("/settings/sending");
  return { ok: true, id: data.id };
}

export async function updateSenderInbox(input: UpdateSenderInboxInput): Promise<SenderActionResult> {
  const user = await requireUser();
  const roleErr = ensureAdmin(user.role);
  if (roleErr) return { ok: false, error: roleErr };

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();

  const payload = {
    display_name: parsed.data.display_name,
    linkedin_url: parsed.data.linkedin_url,
    daily_cap: parsed.data.daily_cap,
    paused: parsed.data.paused,
    paused_reason: parsed.data.paused ? parsed.data.paused_reason : null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("sender_inboxes")
    .update(payload)
    .eq("id", parsed.data.id)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not save sender inbox: ${error.message}` };

  revalidatePath("/settings/sending");
  return { ok: true, id: parsed.data.id };
}

export async function deleteSenderInbox(id: string): Promise<SenderActionResult> {
  const user = await requireUser();
  const roleErr = ensureAdmin(user.role);
  if (roleErr) return { ok: false, error: roleErr };

  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: "Invalid sender inbox id." };

  const supabase = await createClient();

  const { error } = await supabase
    .from("sender_inboxes")
    .delete()
    .eq("id", parsed.data)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not delete sender inbox: ${error.message}` };

  revalidatePath("/settings/sending");
  return { ok: true, id: parsed.data };
}
