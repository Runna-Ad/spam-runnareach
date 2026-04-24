"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const updateProfileSchema = z.object({
  full_name: z.string().trim().min(1).max(120),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z]+(?:\/[A-Za-z_]+)*$/, "Invalid timezone. Use an IANA id like America/Edmonton."),
  avatar_url: z.string().trim().max(500).nullable(),
});

export type UpdateProfileInput = z.input<typeof updateProfileSchema>;

export type ProfileActionResult =
  | { ok: true }
  | { ok: false; error: string };

export async function updateProfile(input: UpdateProfileInput): Promise<ProfileActionResult> {
  const user = await requireUser();

  const parsed = updateProfileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();

  const payload = {
    full_name: parsed.data.full_name,
    timezone: parsed.data.timezone,
    avatar_url:
      parsed.data.avatar_url && parsed.data.avatar_url.trim().length > 0
        ? parsed.data.avatar_url.trim()
        : null,
    updated_at: new Date().toISOString(),
  };

  // supabase-js 2.47 typing quirk — see tasks/lessons.md.
  const { error } = await supabase
    .from("users")
    .update(payload as never)
    .eq("id", user.id);

  if (error) return { ok: false, error: `Could not save profile: ${error.message}` };

  revalidatePath("/settings/profile");
  return { ok: true };
}
