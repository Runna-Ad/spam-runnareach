import { createClient } from "@/lib/supabase/server";

export type DncEntryType = "existing_client" | "competitor" | "runna_staff" | "friend_of_firm";

export type DncEntry = {
  id: string;
  entry_type: DncEntryType;
  email: string | null;
  domain: string | null;
  company_name: string | null;
  notes: string | null;
  added_by_name: string | null;
  created_at: string;
};

export async function listDnc(tenantId: string): Promise<DncEntry[]> {
  const supabase = await createClient();

  type Row = {
    id: string;
    entry_type: DncEntryType;
    email: string | null;
    domain: string | null;
    company_name: string | null;
    notes: string | null;
    created_at: string;
    users: { full_name: string | null } | null;
  };

  const { data, error } = await supabase
    .from("do_not_contact_list")
    .select("id, entry_type, email, domain, company_name, notes, created_at, users(full_name)")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .returns<Row[]>();

  if (error) throw new Error(`Failed to load DNC: ${error.message}`);
  if (!data) return [];

  return data.map((r) => ({
    id: r.id,
    entry_type: r.entry_type,
    email: r.email,
    domain: r.domain,
    company_name: r.company_name,
    notes: r.notes,
    added_by_name: r.users?.full_name ?? null,
    created_at: r.created_at,
  }));
}
