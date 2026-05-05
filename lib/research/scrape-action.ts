"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { scrapeSite, type SubPageExtract } from "./scraper";
import { isRoleBasedEmail } from "./email-utils";
import { hunterDomainSearch } from "./hunter";

const inputSchema = z.object({
  prospect_id: z.string().uuid(),
});

export type ScrapeWebsiteResult =
  | {
      ok: true;
      tech_count: number;
      emails_count: number;
      what_they_do_set: boolean;
      hunter_emails_count: number;
    }
  | {
      ok: false;
      error: string;
      // Hunter may still have found contacts even when the scrape failed
      hunter_emails_count?: number;
    };

/**
 * Server action wired to the "Scrape website" button on the prospect
 * detail page. Steps:
 *   1. Load prospect, validate it has a domain
 *   2. Run the Cheerio scraper
 *   3. Merge into prospect_research:
 *      - what_they_do is set ONLY if currently null (don't clobber human edits)
 *      - tech_stack is unioned (preserve human additions)
 *      - evidence_urls gets the scraped URL + key-page URLs appended
 *      - notes get a one-liner about contact emails / socials so they're visible
 *      - research_method = 'scraped' if it was 'manual' before; otherwise unchanged
 *      - last_scraped_at updated
 *   4. If status is 'raw', bump to 'researched'
 */
export async function scrapeWebsite(prospectId: string): Promise<ScrapeWebsiteResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot scrape." };

  const parsed = inputSchema.safeParse({ prospect_id: prospectId });
  if (!parsed.success) return { ok: false, error: "Invalid prospect id." };

  const supabase = await createClient();

  type ProspectRow = {
    id: string;
    domain: string | null;
    website_url: string | null;
    status: string;
  };
  const { data: prospect, error: prospectErr } = await supabase
    .from("prospects")
    .select("id, domain, website_url, status")
    .eq("id", parsed.data.prospect_id)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<ProspectRow>();

  if (prospectErr) return { ok: false, error: `Lookup failed: ${prospectErr.message}` };
  if (!prospect) return { ok: false, error: "Prospect not found." };

  const target = prospect.website_url ?? (prospect.domain ? `https://${prospect.domain}` : null);
  if (!target) {
    return {
      ok: false,
      error: "Prospect has no domain or website URL — add one in Overview first.",
    };
  }

  const result = await scrapeSite(target);
  if (!result.ok) {
    const e = result.error;
    const msg =
      e.kind === "timeout"
        ? "Site took too long to respond (15s timeout)."
        : e.kind === "http"
          ? `Site returned HTTP ${e.status}.`
          : e.kind === "too_large"
            ? `Page too large (${(e.bytes / 1_048_576).toFixed(1)} MB cap).`
            : e.kind === "not_html"
              ? `Not an HTML page (got ${e.content_type || "unknown content-type"}).`
              : e.kind === "parse"
                ? `Parser failed: ${e.detail}`
                : `Network error: ${e.detail}`;

    // Scrape failed — still try Hunter if we have the domain.
    // Hunter queries its own database and doesn't need the site to be reachable.
    const domain = prospect.domain ?? null;
    if (domain) {
      const hunterResult = await hunterDomainSearch(domain);
      if (hunterResult.ok && hunterResult.contacts.length > 0) {
        const supabase = await createClient();
        let hunterCount = 0;
        for (const contact of hunterResult.contacts) {
          const rank = contact.confidence >= 70 ? 1 : 2;
          const { error: insertErr } = await supabase.from("prospect_contacts").insert({
            tenant_id: user.tenantId,
            prospect_id: parsed.data.prospect_id,
            email: contact.email,
            full_name:
              contact.first_name || contact.last_name
                ? [contact.first_name, contact.last_name].filter(Boolean).join(" ")
                : null,
            role_title: contact.position ?? null,
            email_is_role_based: false,
            priority_rank: rank,
            selected_by: "hunter",
            selected_at: new Date().toISOString(),
          } as never);
          if (!insertErr || insertErr.code === "23505") hunterCount++;
        }
        if (hunterCount > 0) {
          revalidatePath(`/companies/${parsed.data.prospect_id}`);
          return { ok: false, error: `${msg} Hunter found ${hunterCount} contact${hunterCount === 1 ? "" : "s"} for this domain.`, hunter_emails_count: hunterCount };
        }
      }
    }

    return { ok: false, error: msg };
  }

  // Load existing research (if any) to merge.
  type ResearchRow = {
    id: string;
    what_they_do: string | null;
    tech_stack: string[];
    notes: string | null;
    evidence_urls: string[];
    research_method: string;
  };
  const { data: existing, error: existingErr } = await supabase
    .from("prospect_research")
    .select("id, what_they_do, tech_stack, notes, evidence_urls, research_method")
    .eq("tenant_id", user.tenantId)
    .eq("prospect_id", parsed.data.prospect_id)
    .maybeSingle<ResearchRow>();

  if (existingErr) {
    return { ok: false, error: `Lookup failed: ${existingErr.message}` };
  }

  const site = result.site;
  const mergedTechStack = unionUnique(existing?.tech_stack ?? [], site.tech_stack);
  const mergedEvidence = unionUnique(existing?.evidence_urls ?? [], [
    site.final_url,
    ...site.key_pages.map((p) => p.url),
  ]);

  const scrapedNotes = buildScrapedNotesAddendum(site);
  const mergedNotes = mergeNotes(existing?.notes ?? null, scrapedNotes);

  const whatTheyDo = existing?.what_they_do?.trim()
    ? existing.what_they_do
    : site.what_they_do;

  // If the existing row was already manually authored, keep that label.
  const nextMethod =
    existing?.research_method === "manual" || existing?.research_method === "claude_assisted"
      ? existing.research_method
      : "scraped";

  if (existing) {
    const { error } = await supabase
      .from("prospect_research")
      .update({
        what_they_do: whatTheyDo,
        tech_stack: mergedTechStack,
        notes: mergedNotes,
        evidence_urls: mergedEvidence,
        research_method: nextMethod,
        last_scraped_at: site.scraped_at,
        last_edited_by_user_id: user.id,
      })
      .eq("id", existing.id);
    if (error) return { ok: false, error: `Could not save: ${error.message}` };
  } else {
    const { error } = await supabase.from("prospect_research").insert({
      tenant_id: user.tenantId,
      prospect_id: parsed.data.prospect_id,
      what_they_do: whatTheyDo,
      tech_stack: mergedTechStack,
      notes: mergedNotes,
      evidence_urls: mergedEvidence,
      research_method: nextMethod,
      last_scraped_at: site.scraped_at,
      last_edited_by_user_id: user.id,
    });
    if (error) return { ok: false, error: `Could not create: ${error.message}` };
  }

  // Auto-populate prospect_contacts from scraped emails.
  // priority_rank=2 (personal) or 5 (role-based) so deliberate contacts
  // from structured-research (rank=1) always win in the pitch generator.
  for (const email of site.contact_emails) {
    const roleBased = isRoleBasedEmail(email);
    await supabase.from("prospect_contacts").insert({
      tenant_id: user.tenantId,
      prospect_id: parsed.data.prospect_id,
      email: email.toLowerCase(),
      email_is_role_based: roleBased,
      priority_rank: roleBased ? 5 : 2,
      selected_by: "scraper",
      selected_at: new Date().toISOString(),
    } as never);
    // 23505 = unique violation — email already saved; safe to ignore.
  }

  // If the scraper found no personal emails, ask Hunter.io for known contacts
  // at this domain. Hunter is skipped silently if the API key is not set.
  const scrapedPersonalCount = site.contact_emails.filter((e) => !isRoleBasedEmail(e)).length;
  let hunterEmailsCount = 0;

  if (scrapedPersonalCount === 0) {
    const domain = prospect.domain ?? site.final_url.replace(/^https?:\/\//, "").split("/")[0];
    const hunterResult = await hunterDomainSearch(domain ?? "");
    if (hunterResult.ok && hunterResult.contacts.length > 0) {
      for (const contact of hunterResult.contacts) {
        // High-confidence Hunter results (>=70) get rank=1 so they surface
        // above generic scraper finds; lower confidence gets rank=2.
        const rank = contact.confidence >= 70 ? 1 : 2;
        const { error } = await supabase.from("prospect_contacts").insert({
          tenant_id: user.tenantId,
          prospect_id: parsed.data.prospect_id,
          email: contact.email,
          full_name:
            contact.first_name || contact.last_name
              ? [contact.first_name, contact.last_name].filter(Boolean).join(" ")
              : null,
          role_title: contact.position ?? null,
          email_is_role_based: false,
          priority_rank: rank,
          selected_by: "hunter",
          selected_at: new Date().toISOString(),
        } as never);
        if (!error || error.code === "23505") hunterEmailsCount++;
      }
    }
  }

  // Auto-bump status raw → researched.
  if (prospect.status === "raw") {
    await supabase
      .from("prospects")
      .update({ status: "researched", updated_at: new Date().toISOString() })
      .eq("id", parsed.data.prospect_id)
      .eq("tenant_id", user.tenantId);
  }

  await writeAuditLog({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "prospect.scraped",
    entityType: "prospect",
    entityId: parsed.data.prospect_id,
    metadata: {
      target,
      final_url: site.final_url,
      tech_count: mergedTechStack.length,
      emails_count: site.contact_emails.length,
      hunter_emails_count: hunterEmailsCount,
      key_pages: site.key_pages.length,
      sub_pages_scraped: site.sub_page_extracts.length,
    },
  });

  revalidatePath(`/companies/${parsed.data.prospect_id}`);

  return {
    ok: true,
    tech_count: mergedTechStack.length,
    emails_count: site.contact_emails.length,
    what_they_do_set: Boolean(whatTheyDo),
    hunter_emails_count: hunterEmailsCount,
  };
}

function unionUnique<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const v of [...a, ...b]) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function buildScrapedNotesAddendum(site: {
  contact_emails: string[];
  social_links: { platform: string; url: string }[];
  key_pages: { label: string; url: string }[];
  sub_page_extracts: SubPageExtract[];
}): string | null {
  const lines: string[] = [];

  if (site.contact_emails.length > 0) {
    lines.push(`Contact emails: ${site.contact_emails.slice(0, 5).join(", ")}`);
  }
  if (site.social_links.length > 0) {
    lines.push(
      `Social: ${site.social_links.map((s) => `${s.platform}: ${s.url}`).join(" · ")}`,
    );
  }
  if (site.key_pages.length > 0) {
    lines.push(
      `Key pages: ${site.key_pages.map((p) => `${p.label} (${p.url})`).join(" · ")}`,
    );
  }

  // Sub-page body text — gives Claude rich context for pitch generation
  for (const sp of site.sub_page_extracts) {
    lines.push(`\n[${sp.label} page]\n${sp.text}`);
  }

  if (lines.length === 0) return null;
  return `[Scraped ${new Date().toISOString().slice(0, 10)}]\n${lines.join("\n")}`;
}

function mergeNotes(existing: string | null, scraped: string | null): string | null {
  if (!scraped) return existing;
  if (!existing) return scraped;
  // Strip any prior scraped block before appending the new one so we don't
  // accumulate stale findings.
  const stripped = existing.replace(/\[Scraped \d{4}-\d{2}-\d{2}\][\s\S]*?(?=\n\n|$)/g, "").trim();
  return stripped ? `${stripped}\n\n${scraped}` : scraped;
}
