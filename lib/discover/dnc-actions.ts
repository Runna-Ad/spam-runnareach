"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { normalizeDomain } from "./fuzzy-dedupe";

const entryTypeEnum = z.enum(["existing_client", "competitor", "runna_staff", "friend_of_firm"]);

const addSchema = z
  .object({
    entry_type: entryTypeEnum,
    email: z.string().trim().email().max(200).nullable(),
    domain: z.string().trim().max(200).nullable(),
    company_name: z.string().trim().max(200).nullable(),
    notes: z.string().trim().max(500).nullable(),
  })
  .refine((d) => Boolean(d.email || d.domain || d.company_name), {
    message: "Provide at least one of email, domain, or company name.",
  });

export type AddDncInput = z.input<typeof addSchema>;
export type DncActionResult = { ok: true; id: string } | { ok: false; error: string };

export async function addDnc(input: AddDncInput): Promise<DncActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot edit the DNC list." };

  const parsed = addSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();

  const payload = {
    tenant_id: user.tenantId,
    entry_type: parsed.data.entry_type,
    email: parsed.data.email?.toLowerCase() ?? null,
    domain: parsed.data.domain ? normalizeDomain(parsed.data.domain) : null,
    company_name: parsed.data.company_name ?? null,
    notes: parsed.data.notes ?? null,
    added_by: user.id,
  };

  const { data, error } = await supabase
    .from("do_not_contact_list")
    .insert(payload as never)
    .select("id")
    .single<{ id: string }>();

  if (error) return { ok: false, error: `Could not add DNC entry: ${error.message}` };
  if (!data) return { ok: false, error: "Insert returned no row." };

  revalidatePath("/compliance");
  return { ok: true, id: data.id };
}

export async function removeDnc(id: string): Promise<DncActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot edit the DNC list." };

  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: "Invalid id." };

  const supabase = await createClient();

  const { error } = await supabase
    .from("do_not_contact_list")
    .delete()
    .eq("id", parsed.data)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not remove DNC entry: ${error.message}` };

  revalidatePath("/compliance");
  return { ok: true, id: parsed.data };
}
