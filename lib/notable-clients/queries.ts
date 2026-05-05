import { createClient } from "@/lib/supabase/server";

export type NotableClient = {
  id: string;
  tenant_id: string;
  name: string;
  industry_tags: string[];
  markets: string[];
  relationship_description: string | null;
  services_provided: string[];
  key_result: string | null;
  description_en: string | null;
  description_es: string | null;
  tier: "smb" | "mid_market" | "enterprise";
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/**
 * List all active notable clients for a tenant, optionally filtered by market.
 * Ordered by sort_order ascending.
 */
export async function listNotableClients(
  tenantId: string,
  market?: string,
): Promise<NotableClient[]> {
  const supabase = await createClient();

  let query = supabase
    .from("notable_clients")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (market) {
    query = query.contains("markets", [market]);
  }

  const { data, error } = await query.returns<NotableClient[]>();
  if (error) throw new Error(`Failed to load notable clients: ${error.message}`);
  return data ?? [];
}

/**
 * List ALL notable clients (active + inactive) for the management UI.
 */
export async function listAllNotableClients(tenantId: string): Promise<NotableClient[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("notable_clients")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("sort_order", { ascending: true })
    .returns<NotableClient[]>();

  if (error) throw new Error(`Failed to load notable clients: ${error.message}`);
  return data ?? [];
}
