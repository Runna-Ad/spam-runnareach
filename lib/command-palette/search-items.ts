"use server";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type PaletteItem = {
  /** Stable id for React keys — `group:id`. */
  id: string;
  /** One of "nav" | "case_study" | "icp" | "member". */
  group: "nav" | "case_study" | "icp" | "member";
  /** User-visible primary label. */
  label: string;
  /** Optional secondary label (e.g. industry, role). */
  detail?: string;
  /** Route to navigate to. */
  href: string;
  /** Additional searchable text (fed into cmdk's value). */
  keywords: string[];
};

/**
 * Load every searchable item for the current tenant. Navigation items are
 * merged in on the client — this server action only covers DB-backed items.
 * Returns in insertion order; cmdk handles fuzzy-ranking client-side.
 */
export async function loadPaletteItems(): Promise<PaletteItem[]> {
  const user = await requireUser();
  const supabase = await createClient();

  const [caseStudies, icps, members] = await Promise.all([
    supabase
      .from("case_studies")
      .select("id, client_name, industry")
      .eq("tenant_id", user.tenantId)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .returns<{ id: string; client_name: string; industry: string | null }[]>(),

    supabase
      .from("icps")
      .select("id, name, market")
      .eq("tenant_id", user.tenantId)
      .eq("is_active", true)
      .returns<{ id: string; name: string; market: "CA" | "MX" | "US" | "LATAM" }[]>(),

    supabase
      .from("users")
      .select("id, full_name, email, role")
      .eq("tenant_id", user.tenantId)
      .returns<
        { id: string; full_name: string | null; email: string; role: "admin" | "reviewer" | "viewer" }[]
      >(),
  ]);

  const items: PaletteItem[] = [];

  for (const cs of caseStudies.data ?? []) {
    items.push({
      id: `case_study:${cs.id}`,
      group: "case_study",
      label: cs.client_name,
      detail: cs.industry ?? undefined,
      href: "/case-studies",
      keywords: [cs.client_name, cs.industry ?? "", "case study"],
    });
  }

  for (const icp of icps.data ?? []) {
    items.push({
      id: `icp:${icp.id}`,
      group: "icp",
      label: icp.name,
      detail: icp.market,
      href: "/icp",
      keywords: [icp.name, icp.market, "icp", "ideal customer"],
    });
  }

  for (const m of members.data ?? []) {
    items.push({
      id: `member:${m.id}`,
      group: "member",
      label: m.full_name ?? m.email,
      detail: `${m.role} · ${m.email}`,
      href: "/settings/users",
      keywords: [m.full_name ?? "", m.email, m.role, "member", "teammate"],
    });
  }

  return items;
}
