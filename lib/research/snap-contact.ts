/**
 * SnapVerify — free Tier 1 contact enrichment.
 *
 * Runs BEFORE Anymail / Hunter to extract personal emails from already-scraped
 * prospect data. Zero API credits consumed (just Claude Haiku + a Supabase
 * edge function call).
 *
 * Pipeline:
 *   1. Extract people mentioned on the site (from stored notes + what_they_do)
 *   2. Generate email guesses (firstname@, f.last@, firstlast@, first.last@)
 *   3. Check MX provider for the domain
 *   4. Call verify-email edge function — SMTP probe or graceful fallback
 *   5. If Google Workspace detected → medium-confidence guess (no SMTP needed)
 *   6. Insert best contact into prospect_contacts (selected_by='snapverify_smtp'
 *      or 'snapverify_google_guess')
 *
 * Returns { found: true, email, confidence, method } or { found: false }.
 * Caller (pipeline-action.ts) short-circuits Anymail/Hunter if found=true.
 */

import { z } from "zod";
import { ANTHROPIC_HAIKU_MODEL, structuredCall } from "@/lib/anthropic/client";
import { isRoleBasedEmail } from "@/lib/research/email-utils";
import { searchBrave, braveIsAvailable } from "@/lib/discover/sources/brave-search";

// ── Types ──────────────────────────────────────────────────────────────────────

export type SnapVerifyResult =
  | {
      found: true;
      email: string;
      full_name: string | null;
      role_title: string | null;
      confidence: number;
      // Only SMTP-verified results are treated as "found" now. Unverified
      // pattern guesses on non-catch-all domains are NOT inserted (bounce risk).
      method: "smtp_verified";
    }
  | {
      found: false;
      reason: string;
      // Present only when the domain is CATCH-ALL: a best firstname@domain guess
      // the waterfall may use as a last resort. Catch-all servers accept all
      // mail, so this can't hard-bounce — safe to keep, flagged as a guess.
      catchAllGuess?: { email: string; full_name: string | null; role_title: string | null };
    };

type EmailVerifyResult = {
  email: string;
  smtp_code: number | null;
  verdict: "valid" | "invalid" | "unknown" | "catch_all";
  confidence: number;
};

type EdgeFunctionResponse = {
  results: EmailVerifyResult[];
  provider: string;
  is_catch_all: boolean;
  port25_blocked: boolean;
  mx_host: string | null;
  error?: string;
};

type ExtractedPerson = {
  full_name: string;
  role_title: string | null;
};

// ── Zod schema for Claude Haiku people extraction ─────────────────────────────

const PersonSchema = z.object({
  full_name: z.string().min(2),
  role_title: z.string().nullable(),
});

const PeopleSchema = z.object({
  people: z.array(PersonSchema).max(5),
});

// ── Step 0: Fetch Brave people-intel (2 targeted queries) ─────────────────────
// Deep research runs market-intel queries (reviews, complaints, linkedin social).
// SnapVerify runs its OWN people-focused queries so Haiku sees LinkedIn profiles,
// press mentions, and team bios that never appear on the main website.

async function fetchBravePeopleSnippets(companyName: string, domain: string): Promise<string> {
  if (!braveIsAvailable()) return "";

  // Scope queries with the domain to avoid homonym companies (e.g. two businesses
  // named "Adorn Boutique" in different cities — domain disambiguates them).
  const queries = [
    `"${companyName}" ${domain} CEO OR founder OR owner OR director`,
    `"${companyName}" ${domain} site:linkedin.com/in`,
  ];

  const snippets: string[] = [];
  for (const q of queries) {
    try {
      const r = await searchBrave({ query: q, count: 5 });
      if (r.ok) {
        for (const listing of r.listings.slice(0, 4)) {
          // Include both title-cleaned company name and description snippet
          const text = [listing.company_name, listing.description].filter(Boolean).join(" — ");
          if (text.length > 10) snippets.push(text);
        }
      }
    } catch {
      // Non-fatal: Brave quota exhausted or unavailable
    }
  }

  return snippets.length > 0
    ? `=== WEB PEOPLE INTEL (LinkedIn + press) ===\n${snippets.join("\n")}`
    : "";
}

// ── Step 1: Extract people from stored scrape data + Brave people intel ────────

async function extractPeople(
  notes: string | null,
  whatTheyDo: string | null,
  braveSnippets: string,
): Promise<ExtractedPerson[]> {
  // Priority order: Brave people-intel (LinkedIn/press) > scraped notes > what_they_do.
  // Brave snippets go first so Haiku sees the most authoritative source before
  // website copy that might only say "family-owned business" with no names.
  const combined = [braveSnippets, whatTheyDo, notes]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4000); // bumped from 3000 to fit Brave snippets

  if (!combined || combined.trim().length < 20) return [];

  const result = await structuredCall({
    model: ANTHROPIC_HAIKU_MODEL,
    schema: PeopleSchema,
    max_tokens: 300,
    system:
      "You extract real named people (owners, founders, directors, managers) from business content. " +
      "Sources include LinkedIn profiles, press mentions, team bios, and website copy. " +
      "Prefer current decision-makers (CEO, GM, Director) over retired founders. " +
      "Return only people with full names (first + last). Skip generic role mentions without names. " +
      "Skip email addresses and phone numbers. Return max 3 most senior/current people.",
    user: `Extract named decision-makers from this business content:\n\n${combined}`,
  });

  if (!result.ok) return [];
  return result.data.people.map((p) => ({
    full_name: p.full_name.trim(),
    role_title: p.role_title ?? null,
  }));
}

// ── Step 2: Generate email format guesses ─────────────────────────────────────

function generateEmailGuesses(fullName: string, domain: string): string[] {
  const parts = fullName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z\s]/g, "")
    .trim()
    .split(/\s+/);

  if (parts.length < 2) {
    // Single name — just try name@domain
    const single = parts[0];
    if (!single) return [];
    return [`${single}@${domain}`];
  }

  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) return [];

  // Most common formats, ordered by frequency for SMB/retail in MX + CA
  const initial = first[0] ?? "";
  return [
    `${first}@${domain}`,             // pedro@domain.com  — most common for SMB
    `${first}.${last}@${domain}`,     // pedro.dev@domain
    `${initial}${last}@${domain}`,    // pdev@domain
    `${first}${last}@${domain}`,      // pedrodev@domain
  ].filter((e) => !isRoleBasedEmail(e));
}

// ── Step 3: Call verify-email edge function ───────────────────────────────────

async function callVerifyEdgeFunction(
  emails: string[],
  domain: string,
): Promise<EdgeFunctionResponse | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    console.warn("[snapverify] Missing SUPABASE_URL or ANON_KEY — skipping edge fn");
    return null;
  }

  const url = `${supabaseUrl}/functions/v1/verify-email`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${anonKey}`,
        apikey: anonKey,
      },
      body: JSON.stringify({ emails, domain }),
      signal: AbortSignal.timeout(8_000), // short per-pass budget — we run up to 3 passes
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[snapverify] Edge fn returned ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }

    return (await res.json()) as EdgeFunctionResponse;
  } catch (err) {
    console.warn("[snapverify] Edge fn call failed:", (err as Error).message);
    return null;
  }
}

// ── Step 4: Pick best verified email from edge fn response ────────────────────

function pickBestVerified(response: EdgeFunctionResponse): {
  email: string;
  confidence: number;
  method: "smtp_verified";
} | null {
  const valid = response.results.filter((r) => r.verdict === "valid" && r.confidence >= 70);
  if (valid.length === 0) return null;
  // Pick highest confidence
  valid.sort((a, b) => b.confidence - a.confidence);
  const best = valid[0];
  if (!best) return null;
  return { email: best.email, confidence: best.confidence, method: "smtp_verified" };
}

// ── Step 5: Google Workspace heuristic ───────────────────────────────────────
// When MX = Google and port 25 is blocked (or SMTP inconclusive), the most
// reliable pattern for SMB is firstname@domain. Confidence ~70 (medium).

function googleWorkspaceGuess(
  people: ExtractedPerson[],
  domain: string,
): { email: string; confidence: number; method: "google_workspace_guess" } | null {
  if (people.length === 0) return null;

  // Prefer owner/founder/CEO
  const seniorityKeywords = ["owner", "founder", "ceo", "director", "president", "gerente", "dueño", "socio"];
  const senior =
    people.find((p) =>
      p.role_title && seniorityKeywords.some((k) => p.role_title!.toLowerCase().includes(k)),
    ) ?? people[0];
  if (!senior) return null;

  const parts = senior.full_name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, "")
    .trim()
    .split(/\s+/);

  if (!parts[0]) return null;

  const email = `${parts[0]}@${domain}`;
  if (isRoleBasedEmail(email)) return null;

  return { email, confidence: 70, method: "google_workspace_guess" };
}

// ── Export: one-shot SMTP screen for scraped emails ──────────────────────────

/**
 * Screen already-found addresses (e.g. scraped off the prospect's site)
 * against the SMTP probe. Returns the subset that did NOT come back
 * "invalid" — i.e. drops only addresses the mail server actively rejected
 * (550 no-such-user class). When the probe is unavailable or inconclusive
 * (port 25 blocked, catch-all, network error) every email is kept: this is
 * a bounce filter, not a deliverability guarantee.
 *
 * Single pass with a short timeout — callers sit inside time-budgeted
 * pipeline slices, so no greylisting retries here.
 */
export async function screenEmailsAgainstSmtp(
  emails: string[],
  domain: string,
): Promise<string[]> {
  if (emails.length === 0) return emails;
  const result = await callVerifyEdgeFunction(emails, domain);
  if (!result || result.port25_blocked || result.is_catch_all) return emails;
  const invalid = new Set(
    result.results.filter((r) => r.verdict === "invalid").map((r) => r.email.toLowerCase()),
  );
  if (invalid.size === 0) return emails;
  return emails.filter((e) => !invalid.has(e.toLowerCase()));
}

// ── Main export: enrich a single prospect ────────────────────────────────────

/**
 * Run SnapVerify for a prospect. Reads already-scraped data from the DB,
 * runs targeted Brave people-queries, attempts SMTP verification, falls back
 * to Google Workspace heuristic.
 *
 * @param prospectId  UUID of the prospect
 * @param domain      Clean domain string (e.g. "rvsnappad.com")
 * @param notes       Stored scrape notes (from prospect_research.notes)
 * @param whatTheyDo  Stored what_they_do paragraph
 * @param companyName Company name — used for Brave people-intel queries
 */
export async function snapVerifyEnrich(
  prospectId: string,
  domain: string,
  notes: string | null,
  whatTheyDo: string | null,
  companyName: string,
): Promise<SnapVerifyResult> {
  // Guard: skip obvious garbage domains
  if (!domain || domain.length < 4 || domain.startsWith("facebook") || domain.startsWith("instagram")) {
    return { found: false, reason: "Invalid or social-media domain" };
  }

  // Step 0: Brave people-intel queries (LinkedIn + press — finds decision-makers
  // that don't appear on the company's own website).
  // Domain is included in the query to avoid matching homonym companies.
  const braveSnippets = await fetchBravePeopleSnippets(companyName, domain).catch(() => "");

  // Step 1: Extract people from Brave snippets + scraped content
  const people = await extractPeople(notes, whatTheyDo, braveSnippets).catch(() => []);

  if (people.length === 0) {
    return { found: false, reason: "No named people found in scraped content" };
  }

  // Step 2: Generate email guesses for each person (de-duped, max 8 total)
  const allGuesses: string[] = [];
  const seenEmails = new Set<string>();
  for (const person of people.slice(0, 2)) {
    // limit to top 2 people to keep SMTP probe count low
    for (const guess of generateEmailGuesses(person.full_name, domain)) {
      if (!seenEmails.has(guess)) {
        seenEmails.add(guess);
        allGuesses.push(guess);
      }
    }
    if (allGuesses.length >= 8) break;
  }

  if (allGuesses.length === 0) {
    return { found: false, reason: "Could not derive email guesses from person names" };
  }

  // Step 3: Call edge function — up to 3 passes to ride out greylisting and
  // transient SMTP errors (servers commonly answer "450 try later" on the first
  // probe). Stop early once we get a usable answer.
  let edgeResult = await callVerifyEdgeFunction(allGuesses, domain);
  for (let pass = 2; pass <= 3; pass++) {
    const inconclusive =
      !edgeResult ||
      (!edgeResult.is_catch_all &&
        !edgeResult.port25_blocked &&
        !edgeResult.results.some((r) => r.verdict === "valid"));
    if (!inconclusive) break;
    await new Promise((r) => setTimeout(r, 1_200)); // brief pause for greylisting
    edgeResult = await callVerifyEdgeFunction(allGuesses, domain);
  }

  // Step 4: Try SMTP-verified result first
  if (edgeResult && !edgeResult.port25_blocked && !edgeResult.is_catch_all) {
    const best = pickBestVerified(edgeResult);
    if (best) {
      // Map email back to person for name/role
      const matchedPerson = people.find((p) =>
        best.email.startsWith(
          (p.full_name.split(" ")[0] ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""),
        ),
      );
      return {
        found: true,
        email: best.email,
        full_name: matchedPerson?.full_name ?? null,
        role_title: matchedPerson?.role_title ?? null,
        confidence: best.confidence,
        method: "smtp_verified",
      };
    }
  }

  // No clean SMTP-valid result. We deliberately DO NOT insert an unverified
  // guess on a normal domain — a hard bounce on a wrong address hurts the warmed
  // sending domain more than a missing contact helps. Returning found:false lets
  // the waterfall fall through to Anymail + Hunter (verified finders).
  //
  // EXCEPTION — catch-all domains: their server ACCEPTS every address, so a
  // firstname@domain guess physically cannot hard-bounce. We surface it as a
  // `catchAllGuess` for the waterfall to use as a LAST resort (after Anymail +
  // Hunter), clearly flagged as a guess.
  const provider = edgeResult?.provider ?? "unknown";
  const port25Blocked = edgeResult?.port25_blocked ?? true;

  if (edgeResult?.is_catch_all) {
    const guess = googleWorkspaceGuess(people, domain); // firstname@domain, senior person
    if (guess) {
      const matchedPerson = people.find((p) =>
        guess.email.startsWith(
          (p.full_name.split(" ")[0] ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""),
        ),
      );
      return {
        found: false,
        reason: `Catch-all domain (${provider}) — no per-mailbox verification possible; surfacing best guess`,
        catchAllGuess: {
          email: guess.email,
          full_name: matchedPerson?.full_name ?? null,
          role_title: matchedPerson?.role_title ?? null,
        },
      };
    }
  }

  return {
    found: false,
    reason: `Provider=${provider}, port25_blocked=${port25Blocked}, catch_all=${edgeResult?.is_catch_all ?? false}, no verified email — deferring to paid verified finders`,
  };
}
