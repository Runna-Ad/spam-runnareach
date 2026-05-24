"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type NotableClientInput = {
  id?: string;
  name: string;
  industry_tags: string[];
  markets: string[];
  relationship_description: string | null;
  services_provided: string[];
  key_result: string | null;
  description_en: string | null;
  description_es: string | null;
  is_active: boolean;
  sort_order: number;
};

export type NotableClientActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export type SimpleActionResult = { ok: true } | { ok: false; error: string };

/**
 * Upsert a notable client. Inserts if no id, updates if id is provided.
 */
export async function upsertNotableClient(
  input: NotableClientInput,
): Promise<NotableClientActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot edit notable clients." };
  }

  const supabase = await createClient();

  const payload = {
    tenant_id: user.tenantId,
    name: input.name.trim(),
    industry_tags: input.industry_tags.map((t) => t.trim()).filter(Boolean),
    markets: input.markets,
    relationship_description: input.relationship_description?.trim() || null,
    services_provided: input.services_provided.map((s) => s.trim()).filter(Boolean),
    key_result: input.key_result?.trim() || null,
    description_en: input.description_en?.trim() || null,
    description_es: input.description_es?.trim() || null,
    is_active: input.is_active,
    sort_order: input.sort_order,
    updated_at: new Date().toISOString(),
  } as const;

  if (input.id) {
    const { error } = await supabase
      .from("notable_clients")
      .update(payload as never)
      .eq("id", input.id)
      .eq("tenant_id", user.tenantId);

    if (error) return { ok: false, error: `Update failed: ${error.message}` };
    revalidatePath("/notable-clients");
    return { ok: true, id: input.id };
  }

  const { data, error } = await supabase
    .from("notable_clients")
    .insert({ ...payload } as never)
    .select("id")
    .single<{ id: string }>();

  if (error) return { ok: false, error: `Insert failed: ${error.message}` };
  if (!data) return { ok: false, error: "Insert returned no row." };

  revalidatePath("/notable-clients");
  return { ok: true, id: data.id };
}

/**
 * Soft-delete a notable client (set is_active = false).
 * Hard deletes are not supported via UI — preserves pitch history integrity.
 */
export async function deactivateNotableClient(id: string): Promise<SimpleActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot deactivate notable clients." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("notable_clients")
    .update({ is_active: false, updated_at: new Date().toISOString() } as never)
    .eq("id", id)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Deactivate failed: ${error.message}` };
  revalidatePath("/notable-clients");
  return { ok: true };
}
