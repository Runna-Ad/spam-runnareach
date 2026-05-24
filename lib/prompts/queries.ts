// SERVER-ONLY — imports next/headers via createClient. Do not import from client components.
// Client-safe types live in ./types.ts
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";
import type { PromptVariant, PromptProposal, PromptWithChampion, PromptDetail } from "./types";
export type { PromptVariant, PromptProposal, PromptWithChampion, PromptDetail } from "./types";

export async function listPromptsWithChampions(tenantId: string): Promise<PromptWithChampion[]> {
  const supabase = await createClient();

  const { data: prompts } = await supabase
    .from("prompts")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("purpose")
    .returns<Database["public"]["Tables"]["prompts"]["Row"][]>();

  if (!prompts || prompts.length === 0) return [];

  const promptIds = prompts.map((p) => p.id);

  // Fetch champion variants
  const { data: champions } = await supabase
    .from("prompt_variants")
    .select("*")
    .in("prompt_id", promptIds)
    .eq("status", "champion")
    .returns<PromptVariant[]>();

  // Fetch pending proposal counts
  const { data: proposals } = await supabase
    .from("prompt_change_proposals")
    .select("prompt_id")
    .in("prompt_id", promptIds)
    .eq("status", "pending")
    .returns<{ prompt_id: string }[]>();

  const championMap = new Map(champions?.map((c) => [c.prompt_id, c]) ?? []);
  const pendingMap = new Map<string, number>();
  for (const p of proposals ?? []) {
    pendingMap.set(p.prompt_id, (pendingMap.get(p.prompt_id) ?? 0) + 1);
  }

  return prompts.map((p) => ({
    id: p.id,
    purpose: p.purpose,
    language: p.language,
    description: p.description,
    is_active: p.is_active,
    updated_at: p.updated_at,
    champion: championMap.get(p.id) ?? null,
    pending_proposals: pendingMap.get(p.id) ?? 0,
  }));
}

export async function getPromptDetail(promptId: string): Promise<PromptDetail | null> {
  const supabase = await createClient();

  const { data: rawPrompt } = await supabase
    .from("prompts")
    .select("*")
    .eq("id", promptId)
    .single();

  const prompt = rawPrompt as Database["public"]["Tables"]["prompts"]["Row"] | null;
  if (!prompt) return null;

  const { data: variants } = await supabase
    .from("prompt_variants")
    .select("*")
    .eq("prompt_id", promptId)
    .order("created_at", { ascending: false })
    .returns<PromptVariant[]>();

  const { data: proposals } = await supabase
    .from("prompt_change_proposals")
    .select("*")
    .eq("prompt_id", promptId)
    .in("status", ["pending", "ab_testing"])
    .order("proposed_at", { ascending: false })
    .returns<PromptProposal[]>();

  const variantMap = new Map((variants ?? []).map((v) => [v.id, v]));

  const allVariants = variants ?? [];
  const champion = allVariants.find((v) => v.status === "champion") ?? null;

  return {
    id: prompt.id,
    purpose: prompt.purpose,
    language: prompt.language,
    description: prompt.description,
    is_active: prompt.is_active,
    variants: allVariants,
    champion,
    proposals: (proposals ?? []).map((p) => ({
      ...p,
      current_variant: p.current_variant_id ? (variantMap.get(p.current_variant_id) ?? null) : null,
      proposed_variant: p.proposed_variant_id ? (variantMap.get(p.proposed_variant_id) ?? null) : null,
    })),
  };
}
