import { createClient } from "@/lib/supabase/server";

export type WarmingStage = "not_started" | "warming" | "warm" | "paused" | "blocked";

export type SenderInbox = {
  id: string;
  tenant_id: string;
  brand_instance_id: string;
  brand_display_name: string;
  user_id: string | null;
  user_full_name: string | null;
  email: string;
  display_name: string;
  linkedin_url: string | null;
  warming_stage: WarmingStage;
  daily_cap: number;
  sends_today: number;
  paused: boolean;
  paused_reason: string | null;
  gmail_connected: boolean;
  created_at: string;
};

export type BrandLite = {
  id: string;
  code: string;
  display_name: string;
  primary_market: "CA" | "MX" | "US" | "LATAM";
};

export async function listSenderInboxes(tenantId: string): Promise<SenderInbox[]> {
  const supabase = await createClient();

  type Row = {
    id: string;
    tenant_id: string;
    brand_instance_id: string;
    user_id: string | null;
    email: string;
    display_name: string;
    linkedin_url: string | null;
    warming_stage: WarmingStage;
    daily_cap: number;
    sends_today: number;
    paused: boolean;
    paused_reason: string | null;
    gmail_refresh_token_encrypted: string | null;
    created_at: string;
    brand_instances: { display_name: string } | null;
    users: { full_name: string | null } | null;
  };

  const { data, error } = await supabase
    .from("sender_inboxes")
    .select(
      `
      id, tenant_id, brand_instance_id, user_id, email, display_name, linkedin_url,
      warming_stage, daily_cap, sends_today, paused, paused_reason,
      gmail_refresh_token_encrypted, created_at,
      brand_instances(display_name),
      users(full_name)
    `,
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
    .returns<Row[]>();

  if (error) throw new Error(`Failed to load sender inboxes: ${error.message}`);
  if (!data) return [];

  return data.map((r) => ({
    id: r.id,
    tenant_id: r.tenant_id,
    brand_instance_id: r.brand_instance_id,
    brand_display_name: r.brand_instances?.display_name ?? "—",
    user_id: r.user_id,
    user_full_name: r.users?.full_name ?? null,
    email: r.email,
    display_name: r.display_name,
    linkedin_url: r.linkedin_url,
    warming_stage: r.warming_stage,
    daily_cap: r.daily_cap,
    sends_today: r.sends_today,
    paused: r.paused,
    paused_reason: r.paused_reason,
    gmail_connected: Boolean(r.gmail_refresh_token_encrypted),
    created_at: r.created_at,
  }));
}

export async function listBrands(tenantId: string): Promise<BrandLite[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("brand_instances")
    .select("id, code, display_name, primary_market")
    .eq("tenant_id", tenantId)
    .order("display_name", { ascending: true })
    .returns<BrandLite[]>();

  if (error) throw new Error(`Failed to load brand instances: ${error.message}`);
  return data ?? [];
}
