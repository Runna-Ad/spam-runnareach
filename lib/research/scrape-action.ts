"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { scrapeSite, type SubPageExtract } from "./scraper";
import { isRoleBasedEmail } from "./email-utils";
import { screenEmailsAgainstSmtp } from "./snap-contact";

const inputSchema = z.object({
  prospect_id: z.string().uuid(),
});

export type ScrapeWebsiteResult =
  | {
      ok: true;
      tech_count: number;
      emails_count: number;
      what_they_do_set: boolean;
      contact_insert_errors: string[];
    }
  | {
      ok: false;
      error: string;
      /** True when a "website unreachable" pain point was recorded on the prospect. */
      pain_point_added?: boolean;
      /**
       * True when DNS says the domain doesn't exist at all. The pipeline uses
       * this to clear the (possibly mis-discovered) domain and route the
       * prospect to the honest no-website pitch lane instead of emailing them
       * about "their" broken site.
       */
      domain_dead?: boolean;
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
    company_name: string;
    domain: string | null;
    website_url: string | null;
    status: string;
    match_score: number | null;
    language: string | null;
    market: string | null;
  };
  const { data: prospect, error: prospectErr } = await supabase
    .from("prospects")
    .select("id, company_name, domain, website_url, status, match_score, language, market")
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
        : e.kind === "dns"
          ? "Domain doesn't exist (no DNS records) — the stored website is wrong or lapsed."
          : e.kind === "http"
            ? `Site returned HTTP ${e.status}.`
            : e.kind === "too_large"
              ? `Page too large (${(e.bytes / 1_048_576).toFixed(1)} MB — cap is 4 MB).`
              : e.kind === "not_html"
                ? `Not an HTML page (got ${e.content_type || "unknown content-type"}).`
                : e.kind === "parse"
                  ? `Parser failed: ${e.detail}`
                  : `Can't reach site — it may not exist or is blocking automated requests.`;

    // DNS-dead: the domain doesn't exist. We can't know whether it was ever
    // theirs (auto-discovery can attach a wrong domain), so we must NEVER email
    // them claiming "your site acadianlogworks.com is down" — that exact
    // mistake lost a warm lead. Surface domain_dead so the pipeline clears the
    // domain and pitches the honest "no website" angle instead.
    if (e.kind === "dns") {
      return { ok: false, error: scrapeMsg, domain_dead: true };
    }

    // The "website unreachable" pain point is only defensible when the site
    // verifiably EXISTS (DNS resolves) but serves an error a visitor would
    // also hit: 404/410/5xx. Timeouts and 401/403/406/429 usually mean the
    // site blocks bots while working fine in a browser — claiming it's down
    // would be false. Those (plus scraper-side failures) just return an error.
    const isSiteBroken =
      e.kind === "http" && (e.status === 404 || e.status === 410 || e.status >= 500);

    // AND the domain must plausibly be THEIRS: a company-name token must
    // appear in it. Auto-discovery has attached wrong domains before — telling
    // a prospect "your site is broken" about a stranger's domain lost a lead.
    const nameTokens = prospect.company_name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4);
    const domainLc = (prospect.domain ?? target).toLowerCase();
    const domainLooksTheirs = nameTokens.some((t) => domainLc.includes(t));

    if (!isSiteBroken || !domainLooksTheirs) {
      return { ok: false, error: scrapeMsg };
    }

    // Build a usable evidence quote from the error so the pitch can open with it.
    // e.g. "Checked homedecoration.com.mx — returned HTTP 500"
    const domainLabel = prospect.domain ?? target;
    const unreachableQuote = `Checked ${domainLabel} — returned HTTP ${e.status}.`;

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

    // Contact enrichment is deliberately NOT run here. Paid enrichment
    // (Anymail/Hunter) is score-gated and owned by the waterfall in
    // lib/discover/enrich-contacts.ts (pipeline + bulk re-score). Scrape
    // never sets status — the pipeline/score triage owns status transitions.
    revalidatePath(`/companies/${parsed.data.prospect_id}`);
    return {
      ok: false,
      error: painMergeOk
        ? `${scrapeMsg} Logged "website unreachable" as a pain point.`
        : scrapeMsg,
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

  const rawSite = result.site;

  // Screen same-domain scraped addresses against the SMTP probe before they
  // touch research notes or prospect_contacts — pages routinely display stale
  // addresses the mail server no longer knows ("550 No Such User Here"
  // bounces). Off-domain addresses (gmail etc.) can't be probed in one batch
  // and are kept as-is. Best-effort: probe unavailable → keep everything.
  let screenedEmails = rawSite.contact_emails;
  if (prospect.domain) {
    const sameDomain = screenedEmails.filter((e) => e.endsWith(`@${prospect.domain}`));
    if (sameDomain.length > 0) {
      try {
        const passed = new Set(await screenEmailsAgainstSmtp(sameDomain, prospect.domain));
        screenedEmails = screenedEmails.filter(
          (e) => !e.endsWith(`@${prospect.domain}`) || passed.has(e),
        );
      } catch {
        // Screening is best-effort — keep all emails if the probe errors.
      }
    }
  }
  const site = { ...rawSite, contact_emails: screenedEmails };
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

  // Contact enrichment is deliberately NOT run here. Paid enrichment
  // (Anymail/Hunter) is score-gated and owned by the waterfall in
  // lib/discover/enrich-contacts.ts (pipeline + bulk re-score). Scrape only
  // records on-site contacts (above) into prospect_contacts.

  // Auto-fill language + market on the prospect if currently null.
  // Never overwrites a human-set value — only fills the gap.
  const prospectPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (!prospect.language) prospectPatch.language = site.language;
  if (!prospect.market && site.market) prospectPatch.market = site.market;
  // Repair hostname-derived company names ("Acadianlogworks", "Best-pet-food")
  // with the site's OWN name — discovery sources fall back to capitalizing the
  // hostname when page titles are junk, and that fake name then shows up in
  // sent emails. Only replaces names that clearly came from the hostname.
  if (site.site_name && looksHostnameDerived(prospect.company_name, prospect.domain)) {
    prospectPatch.company_name = site.site_name.slice(0, 200);
  }
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
    contact_insert_errors: contactInsertErrors,
  };
}

/**
 * True when a company name is just the domain's first label with cosmetic
 * casing — the discovery-source fallback ("acadianlogworks.com" →
 * "Acadianlogworks"). One-word names that don't match the hostname (real
 * brands like "Nike") are left alone.
 */
function looksHostnameDerived(companyName: string, domain: string | null): boolean {
  if (!domain) return false;
  // The hostname fallback never produces spaces — a spaced name is human/source
  // data and must not be overwritten even if it flattens to the hostname.
  if (/\s/.test(companyName.trim())) return false;
  const firstLabel = (domain.replace(/^www\./, "").split(".")[0] ?? "").toLowerCase();
  if (!firstLabel) return false;
  const nameFlat = companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return nameFlat === firstLabel.replace(/[^a-z0-9]/g, "");
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
