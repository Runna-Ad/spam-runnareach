"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { scrapeSite, type SubPageExtract } from "./scraper";
import { isRoleBasedEmail } from "./email-utils";
import { hunterDomainSearch } from "./hunter";
import { anymailFindDecisionMaker } from "./anymail-finder";

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
      anymail_found: boolean;
      contact_insert_errors: string[];
    }
  | {
      ok: false;
      error: string;
      hunter_emails_count?: number;
      anymail_found?: boolean;
      /** True when we automatically archived the lead (site dead + no contacts found). */
      auto_archived?: boolean;
      /** True when site was unreachable but contacts were found via Hunter/Anymail. */
      pain_point_added?: boolean;
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
    match_score: number | null;
    language: string | null;
    market: string | null;
  };
  const { data: prospect, error: prospectErr } = await supabase
    .from("prospects")
    .select("id, domain, website_url, status, match_score, language, market")
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

    // Human-readable reason for the UI.
    const scrapeMsg =
      e.kind === "timeout"
        ? "Site took too long to respond — it may be blocking automated requests."
        : e.kind === "http"
          ? `Site returned HTTP ${e.status}.`
          : e.kind === "too_large"
            ? `Page too large (${(e.bytes / 1_048_576).toFixed(1)} MB — cap is 4 MB).`
            : e.kind === "not_html"
              ? `Not an HTML page (got ${e.content_type || "unknown content-type"}).`
              : e.kind === "parse"
                ? `Parser failed: ${e.detail}`
                : `Can't reach site — it may not exist or is blocking automated requests.`;

    // "too_large" and "not_html" and "parse" are scraper-side failures, not dead-website
    // signals. Only treat network/timeout/http errors as "site unreachable" for the
    // pain-point + contact-fallback path.
    const isSiteUnreachable =
      e.kind === "network" || e.kind === "timeout" || e.kind === "http";

    if (!isSiteUnreachable) {
      return { ok: false, error: scrapeMsg };
    }

    // Build a usable evidence quote from the error so the pitch can open with it.
    // e.g. "Checked homedecoration.com.mx — site doesn't exist"
    const evidenceDetail =
      e.kind === "timeout"
        ? "site didn't respond"
        : e.kind === "http"
          ? `returned HTTP ${e.status}`
          : `site doesn't appear to exist`;
    const domainLabel = prospect.domain ?? target;
    const unreachableQuote = `Checked ${domainLabel} — ${evidenceDetail}.`;

    // Persist the "website unreachable" pain point so it surfaces in pitch generation.
    // Best opener: "Checked your site — it's down."
    type ResearchForMerge = { id: string; pain_points: unknown };
    const { data: existingResearch } = await supabase
      .from("prospect_research")
      .select("id, pain_points")
      .eq("tenant_id", user.tenantId)
      .eq("prospect_id", parsed.data.prospect_id)
      .maybeSingle<ResearchForMerge>();

    const unreachablePain = {
      pain_id: "website_unreachable",
      pain_label: "Website is down or unreachable",
      evidence_quote: unreachableQuote,
    };

    let painMergeOk = false;
    if (existingResearch) {
      const existing = Array.isArray(existingResearch.pain_points)
        ? (existingResearch.pain_points as { pain_id?: string }[])
        : [];
      if (!existing.some((p) => p.pain_id === "website_unreachable")) {
        const { error: mergeErr } = await supabase
          .from("prospect_research")
          .update({ pain_points: [...existing, unreachablePain] as unknown as object[] } as never)
          .eq("id", existingResearch.id)
          .eq("tenant_id", user.tenantId);
        painMergeOk = !mergeErr;
      } else {
        painMergeOk = true;
      }
    } else {
      const { error: insertErr } = await supabase
        .from("prospect_research")
        .insert({
          tenant_id: user.tenantId,
          prospect_id: parsed.data.prospect_id,
          research_method: "scraped",
          pain_points: [unreachablePain] as unknown as object[],
          tech_stack: [],
          evidence_urls: [],
        } as never);
      painMergeOk = !insertErr;
    }

    // Try Anymail first, Hunter only if Anymail misses — preserves free-tier credits.
    // Score gate (≥ 80) still applies: dead website on a low scorer is a dead end.
    const domain = prospect.domain ?? null;
    const isHighValue = (prospect.match_score ?? 0) >= 80;
    let hunterCount = 0;
    let anymailFound = false;

    if (domain && isHighValue) {
      // Anymail first — verified decision-maker, rank=1
      const anymailResult = await anymailFindDecisionMaker(domain);
      if (anymailResult.ok) {
        const c = anymailResult.contact;
        const { error: insertErr } = await supabase.from("prospect_contacts").insert({
          tenant_id: user.tenantId,
          prospect_id: parsed.data.prospect_id,
          email: c.email,
          full_name: c.full_name ?? null,
          role_title: c.job_title ?? null,
          linkedin_url: c.linkedin_url ?? null,
          email_is_role_based: false,
          priority_rank: 1,
          selected_by: "anymail",
          selected_at: new Date().toISOString(),
        } as never);
        if (!insertErr || insertErr.code === "23505") anymailFound = true;
      }

      // Hunter only if Anymail didn't find a verified contact — saves credits
      if (!anymailFound) {
        const hunterResult = await hunterDomainSearch(domain);
        if (hunterResult.ok && hunterResult.contacts.length > 0) {
          for (const contact of hunterResult.contacts) {
            const rank = contact.confidence >= 70 ? 2 : 3;
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
        }
      }
    }

    // No contacts + low score, OR no contacts + high score but nothing found
    // → auto-archive. No website, no email = dead lead.
    if (!anymailFound && hunterCount === 0) {
      await supabase
        .from("prospects")
        .update({ status: "no_match", updated_at: new Date().toISOString() } as never)
        .eq("id", parsed.data.prospect_id)
        .eq("tenant_id", user.tenantId);

      revalidatePath(`/companies/${parsed.data.prospect_id}`);
      return {
        ok: false,
        error: isHighValue
          ? `${scrapeMsg} No contacts found via Hunter or Anymail. Lead auto-archived.`
          : `${scrapeMsg} Score below 80 — lead auto-archived without spending credits.`,
        hunter_emails_count: 0,
        anymail_found: false,
        auto_archived: true,
        pain_point_added: painMergeOk,
      };
    }

    // Contacts found — keep the lead alive with the pain point logged.
    const contactParts = [
      anymailFound ? "1 verified contact via Anymail" : null,
      hunterCount > 0 ? `${hunterCount} contact${hunterCount === 1 ? "" : "s"} via Hunter` : null,
    ].filter(Boolean).join(", ");

    revalidatePath(`/companies/${parsed.data.prospect_id}`);
    return {
      ok: false,
      error: `${scrapeMsg} Found ${contactParts} — "website unreachable" added as a pain point.`,
      hunter_emails_count: hunterCount,
      anymail_found: anymailFound,
      pain_point_added: painMergeOk,
    };
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
      } as never)
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
    } as never);
    if (error) return { ok: false, error: `Could not create: ${error.message}` };
  }

  // Auto-populate prospect_contacts from scraped emails.
  // priority_rank=2 (personal) or 5 (role-based) so deliberate contacts
  // from structured-research (rank=1) always win in the pitch generator.
  const contactInsertErrors: string[] = [];
  for (const email of site.contact_emails) {
    const roleBased = isRoleBasedEmail(email);
    const { error: contactErr } = await supabase.from("prospect_contacts").insert({
      tenant_id: user.tenantId,
      prospect_id: parsed.data.prospect_id,
      email: email.toLowerCase(),
      email_is_role_based: roleBased,
      priority_rank: roleBased ? 5 : 2,
      selected_by: "scraper",
      selected_at: new Date().toISOString(),
    } as never);
    if (contactErr && contactErr.code !== "23505") {
      contactInsertErrors.push(`${email}: ${contactErr.code} ${contactErr.message}`);
    }
  }

  // If the scraper found no personal emails, enrich via Anymail then Hunter (short-circuit).
  // Score gate (≥ 80) applies here too — preserve free-tier credits.
  const scrapedPersonalCount = site.contact_emails.filter((e) => !isRoleBasedEmail(e)).length;
  let hunterEmailsCount = 0;
  let anymailFound = false;
  const qualifiesForEnrichment = (prospect.match_score ?? 0) >= 80;

  if (scrapedPersonalCount === 0 && qualifiesForEnrichment) {
    const domain = prospect.domain ?? site.final_url.replace(/^https?:\/\//, "").split("/")[0];

    // Anymail first — verified decision-maker email, rank=1 (beats everything)
    const anymailResult = await anymailFindDecisionMaker(domain ?? "");
    if (anymailResult.ok) {
      const c = anymailResult.contact;
      const { error } = await supabase.from("prospect_contacts").insert({
        tenant_id: user.tenantId,
        prospect_id: parsed.data.prospect_id,
        email: c.email,
        full_name: c.full_name ?? null,
        role_title: c.job_title ?? null,
        linkedin_url: c.linkedin_url ?? null,
        email_is_role_based: false,
        priority_rank: 1,
        selected_by: "anymail",
        selected_at: new Date().toISOString(),
      } as never);
      if (!error || error.code === "23505") anymailFound = true;
    }

    // Hunter only if Anymail didn't find a verified contact — saves credits
    if (!anymailFound) {
      const hunterResult = await hunterDomainSearch(domain ?? "");
      if (hunterResult.ok && hunterResult.contacts.length > 0) {
        for (const contact of hunterResult.contacts) {
          const rank = contact.confidence >= 70 ? 2 : 3;
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
  }

  // Auto-fill language + market on the prospect if currently null.
  // Never overwrites a human-set value — only fills the gap.
  const prospectPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (!prospect.language) prospectPatch.language = site.language;
  if (!prospect.market && site.market) prospectPatch.market = site.market;
  if (Object.keys(prospectPatch).length > 1) {
    await supabase
      .from("prospects")
      .update(prospectPatch as never)
      .eq("id", parsed.data.prospect_id)
      .eq("tenant_id", user.tenantId);
  }

  // Auto-bump status raw → researched.
  if (prospect.status === "raw") {
    await supabase
      .from("prospects")
      .update({ status: "researched", updated_at: new Date().toISOString() } as never)
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
      anymail_found: anymailFound,
      key_pages: site.key_pages.length,
      sub_pages_scraped: site.sub_page_extracts.length,
      contact_insert_errors: contactInsertErrors.length > 0 ? contactInsertErrors : undefined,
    },
  });

  revalidatePath(`/companies/${parsed.data.prospect_id}`);

  return {
    ok: true,
    tech_count: mergedTechStack.length,
    emails_count: site.contact_emails.length,
    what_they_do_set: Boolean(whatTheyDo),
    hunter_emails_count: hunterEmailsCount,
    anymail_found: anymailFound,
    contact_insert_errors: contactInsertErrors,
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
