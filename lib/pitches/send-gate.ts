// Pre-send verification gate.
//
// The question this answers is NOT "is this pitch well-formed?" — every bug that
// reached a real prospect was well-formed. It answers: "can every claim and
// identifier in this email be traced to something we actually verified?"
//
// Failures this encodes, all of which shipped to real people:
//   - acadianlogworks.com — a website we guessed, asserted as theirs
//   - "Hi Mark," on an email to john.sipos@ — greeting from a different contact
//   - julien-cormier.cavfournier@ — a well-formed address belonging to nobody
//   - "Hi Calgauthier," / "Hi Vfournier," — a surname greeted as a first name
//
// PURE by design: no DB, no network, no side effects. Everything it needs is
// passed in, so every rule is unit-testable against real production fixtures
// and the gate can be dry-run over history before it's ever allowed to send.

import { hasUsableEmail, isRoleBasedEmail } from "../research/email-utils.ts";
import { siteOwnership } from "../research/site-ownership.ts";
import { isTrustedForAutoSend } from "../research/verify-recipient.ts";
import {
  findInternalNames,
  findBannedTerms,
  findClientNames,
  findUnsourcedNumbers,
  fold,
} from "./content-rules.ts";

/**
 * Bump on any rule change, so a stored verdict can be compared against the
 * rules that produced it. v1 was the dry run (2026-07-21): logged, enforced
 * nothing. v2 (2026-10-16) is enforced at approve, queue and send on every path,
 * scans every number in subject and body, and adds the client-name, internal-
 * name, jargon and em-dash rules.
 */
export const GATE_VERSION = 2;

/**
 * block  — objectively broken or untrue; nobody can send it until it's fixed.
 * review — a person may read the flag and approve anyway (recorded as an
 *          override). Automated sends (follow-ups, nudges) treat it as block.
 */
export type GateSeverity = "block" | "review";

/** Why a pitch was held. Shown to the human, so it must name the fix. */
export type GateCode =
  | "unusable_email"
  | "unverified_recipient"
  | "domain_ownership_unsure"
  | "greeting_mismatch"
  | "greeting_not_a_name"
  | "company_name_unverified"
  | "unverifiable_website_claim"
  | "unsourced_metric"
  | "unresolved_placeholder"
  | "broken_cta"
  | "empty_body"
  | "missing_subject"
  | "client_name"
  | "internal_name"
  | "banned_jargon"
  | "em_dash";

export const GATE_SEVERITY: Record<GateCode, GateSeverity> = {
  unusable_email: "block",
  unresolved_placeholder: "block",
  broken_cta: "block",
  empty_body: "block",
  missing_subject: "block",
  // 31 of the 40 dry-run holds were invented statistics, every one approved by
  // a human who didn't spot it. A person reading the flag is not a fix.
  unsourced_metric: "block",
  client_name: "block",
  internal_name: "block",
  unverified_recipient: "review",
  domain_ownership_unsure: "review",
  greeting_mismatch: "review",
  greeting_not_a_name: "review",
  company_name_unverified: "review",
  unverifiable_website_claim: "review",
  banned_jargon: "review",
  em_dash: "review",
};

export type GateFailure = {
  code: GateCode;
  severity: GateSeverity;
  /** Human-readable, specific enough to act on without opening the code. */
  detail: string;
};

export type GateInput = {
  subject: string;
  body: string;
  /** The email's language — decides which banned-term list applies. */
  lang: "en" | "es";
  /** The address this will actually be sent to (resolved by the send path). */
  recipientEmail: string | null;
  /** Recipient's name, when we have a verified one. */
  recipientFullName: string | null;
  /** How the address was obtained — provenance decides trust. */
  recipientSelectedBy: string | null;
  /** Company name as stored on the prospect. */
  companyName: string;
  /** The name the site calls itself (og:site_name/title), when scraped. */
  siteName: string | null;
  /** Prospect domain, if any. */
  domain: string | null;
  /** True when we successfully fetched the site (so claims about it are grounded). */
  websiteVerified: boolean;
  /** Evidence quotes stored on the prospect — sourceable claims about THEM. */
  evidenceQuotes: string[];
  /**
   * Figures from active, human-verified benchmark rows.
   *
   * Rule 5 holds any number that appears in no stored evidence. Until
   * benchmarks existed that rule could only ever say "no", because nothing was
   * a legitimate source for a statistic — so it was effectively a ban. This is
   * the allowlist that turns it into an actual check.
   */
  benchmarkFigures?: string[];
  /** Client names (case studies + notable clients) — never named in a cold email. */
  clientNames?: string[];
  /**
   * False for follow-ups and nudges: their recipient was already vetted by the
   * first email (or wrote to us), so provenance is not re-litigated. The
   * usable-email check still runs.
   */
  checkRecipientSource?: boolean;
};

export type GateResult =
  | { pass: true }
  | { pass: false; failures: GateFailure[] };

/**
 * May this verdict go out? Block-level failures never; review-level ones only
 * when a person accepted that exact code (`acceptedCodes`, from the pitch's
 * gate_override). Returns what still stands in the way.
 */
export function gateAllows(
  result: GateResult,
  acceptedCodes: readonly string[] = [],
): { ok: boolean; outstanding: GateFailure[] } {
  if (result.pass) return { ok: true, outstanding: [] };
  const outstanding = result.failures.filter(
    (f) => f.severity === "block" || !acceptedCodes.includes(f.code),
  );
  return { ok: outstanding.length === 0, outstanding };
}

/** One line per failure, for audit rows and auto_rejected_reason. */
export function describeFailures(failures: readonly GateFailure[]): string {
  return failures.map((f) => `${f.code}: ${f.detail}`).join(" | ");
}

/**
 * Contact provenance we trust enough to send WITHOUT a human. One list, owned
 * by the verifier (isTrustedForAutoSend in lib/research/verify-recipient.ts)
 * and shared with the governor's lane.
 *
 * Excluded on purpose: 'snapverify_catchall_guess' is a firstname@domain guess
 * kept only because a catch-all domain can't hard-bounce — it may reach nobody.
 * A guess is fine for a human to approve; it is not fine to auto-send.
 */
const VERIFIED_PROVENANCE = { has: isTrustedForAutoSend };

/** Words that must never appear as a "first name" in a greeting. */
const NON_NAME_GREETINGS = new Set(["there", "team", "equipo", "hola", "hi", "hello"]);

/**
 * Claims about the prospect's website. If we never fetched the site, the email
 * must not characterise it — that is exactly the Acadian failure.
 */
const WEBSITE_CLAIM_PATTERNS: RegExp[] = [
  /\byour (?:website|site|web ?site|online store)\b/i,
  /\b(?:website|site) (?:is|isn't|is not|looks|seems|appears)\b/i,
  /\bchecked your\b/i,
  // "Checked acme.com" / "Revisé acme.mx" — v1 missed the domain form.
  /\bchecked\s+[\w-]+(?:\.[\w-]+)*\.(?:com|ca|mx|net|org|co|io|biz)\b/i,
  /\brevis[eé] tu\b/i,
  /\brevis[eé]\s+(?:el sitio|la p[áa]gina|la web|su sitio|su p[áa]gina|su tienda)\b/i,
  /\brevis[eé]\s+[\w-]+(?:\.[\w-]+)*\.(?:com|ca|mx|net|org|co|io|biz)\b/i,
  /\btu (?:sitio|p[áa]gina|tienda en l[ií]nea)\b/i,
  /\bsu (?:sitio|p[áa]gina|tienda en l[ií]nea)\b/i,
];

/** Words too common to identify a business on their own. */
const GENERIC_NAME_WORDS = new Set([
  "welcome", "home", "official", "site", "website", "page", "the", "and", "group", "company",
  "inc", "ltd", "llc", "corp", "corporation", "limited", "services", "service", "solutions",
  "manufacturing", "manufacturer", "distribution", "distributor", "wholesale", "wholesaler",
  "hotel", "suites", "restaurant", "clinic", "health", "centre", "center", "design", "build",
  "construction", "studio", "spa", "canada", "mexico", "contract", "electronics", "dynamic",
  "source", "hospitals", "hospital", "law", "office", "firm", "partners",
]);

/**
 * Does the stored company name agree with the site's own name? Whole-string
 * containment first ("Acme" vs "Acme Inc."), then any distinctive word of one
 * found inside the other ("Woodbine Hotel & Suites" vs "Welcome to Woodbine",
 * "Amsted Design-Build" vs "amsted.ca", "Orozco Hermanos" vs "OrozcoHnos").
 * Generic words don't count: "Dynamic Source Manufacturing" vs "Contract
 * Electronics Manufacturing" share only "manufacturing" and still disagree.
 */
export function namesAgree(companyName: string, siteName: string): boolean {
  const compact = (x: string) => fold(x).replace(/\.(?:com|ca|mx|net|org|co)\b/g, "").replace(/[^a-z0-9]/g, "");
  const a = compact(companyName);
  const b = compact(siteName);
  if (a.length < 3 || b.length < 3 || a.includes(b) || b.includes(a)) return true;
  const words = (x: string) =>
    fold(x)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !GENERIC_NAME_WORDS.has(w));
  return words(companyName).some((w) => b.includes(w)) || words(siteName).some((w) => a.includes(w));
}

/** First token of a name, lowercased. */
function firstToken(s: string): string {
  return s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** Honorifics stripped before comparing a greeted name with the recipient's. */
const TITLES = /^(?:(?:lic|ing|dr|dra|arq|mtro|mtra|sr|sra|srta|mr|mrs|ms|miss|prof)\.?\s+)+/i;

/**
 * Pull the greeted name out of the first line: "Hi Mark," / "Hola Miguel," /
 * "Estimado Lic. García," / "Dear Ms. Lee,". Titles are stripped, so the last
 * example returns "Lee". Returns null when the greeting addresses a company or
 * team rather than a person ("Hi Acme team," / "Hola, equipo de Acme,").
 *
 * v1 only knew hi/hello/hey/hola/buenos días, so "Estimado Lic. García" —
 * the register the composer uses for mid-market Mexican prospects — was never
 * checked at all.
 */
export function extractGreetedName(body: string): string | null {
  const firstLine = body.trim().split("\n")[0] ?? "";
  const m = firstLine.match(
    /^\s*(?:hi|hello|hey|dear|hola|buenos d[ií]as|buen d[ií]a|estimad[oa]s?(?:\/a)?)\s*,?\s+([^,\n]+),/i,
  );
  if (!m) return null;
  const greeted = (m[1] ?? "").trim().replace(TITLES, "").trim();
  // "Hi Acme team," / "Hola equipo de Acme," address the company, not a person.
  if (/\b(team|equipo)\b/i.test(greeted)) return null;
  const tok = firstToken(greeted);
  if (!tok || NON_NAME_GREETINGS.has(tok)) return null;
  return greeted;
}

/**
 * Decide whether a pitch may be sent.
 *
 * Every rule is a claim we can defend to the recipient. When in doubt the gate
 * HOLDS — a held pitch costs Pedro thirty seconds; a wrong one costs a lead.
 */
export function evaluateSendGate(input: GateInput): GateResult {
  const failures: GateFailure[] = [];
  const fail = (code: GateCode, detail: string) =>
    failures.push({ code, severity: GATE_SEVERITY[code], detail });
  const both = `${input.subject}\n${input.body}`;

  // ── 1. Recipient must be real and trusted ────────────────────────────────
  if (!hasUsableEmail(input.recipientEmail)) {
    fail("unusable_email", `Recipient "${input.recipientEmail ?? "(none)"}" fails the usable-email check.`);
  } else if (
    input.checkRecipientSource !== false &&
    !VERIFIED_PROVENANCE.has(input.recipientSelectedBy ?? "")
  ) {
    fail(
      "unverified_recipient",
      `Address came from "${input.recipientSelectedBy ?? "unknown"}" — not a verified source. ` +
        `Guessed addresses may reach nobody; approve manually or re-enrich.`,
    );
  }

  // ── 1b. …and on a domain that is actually THIS company's ─────────────────
  // Discovery attaches wrong domains (Corvex Manufacturing → linamar.com,
  // Holiday Inn Niagara → ihg.com), and a scraped or pattern-built address on
  // that domain is real and deliverable: to a stranger. When the site's own
  // name and the domain can't be tied to the company, a person looks first.
  // A manually entered address is the person's call already.
  const recipientDomain = (input.recipientEmail ?? "").split("@")[1]?.trim().toLowerCase() ?? "";
  const prospectDomain = (input.domain ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (
    input.checkRecipientSource !== false &&
    input.recipientSelectedBy !== "manual" &&
    prospectDomain &&
    hasUsableEmail(input.recipientEmail) &&
    (recipientDomain === prospectDomain || recipientDomain.endsWith(`.${prospectDomain}`))
  ) {
    const ownership = siteOwnership(input.companyName, input.siteName, prospectDomain);
    if (ownership === "parked") {
      fail(
        "domain_ownership_unsure",
        `${prospectDomain} is a parked page ("${input.siteName}"): ${input.recipientEmail} reaches whoever holds the domain, not ${input.companyName}.`,
      );
    } else if (ownership === "unsure") {
      fail(
        "domain_ownership_unsure",
        `Can't confirm ${prospectDomain} belongs to ${input.companyName}` +
          (input.siteName ? ` (the site calls itself "${input.siteName}")` : "") +
          `. ${input.recipientEmail} may reach a different company: open the site, then approve anyway if it's theirs.`,
      );
    }
  }

  // ── 2. The greeting must name the ACTUAL recipient ───────────────────────
  if (/^\s*estimad[oa]\/a\b/i.test(input.body)) {
    fail("greeting_mismatch", `Greeting says "Estimado/a" — a mail-merge tell. Pick "Estimado" or "Estimada".`);
  }
  const greeted = extractGreetedName(input.body);
  if (greeted) {
    const greetedTok = fold(firstToken(greeted));
    const knownTokens = input.recipientFullName
      ? fold(input.recipientFullName).split(/\s+/).filter(Boolean)
      : [];
    const localPart = fold((input.recipientEmail ?? "").split("@")[0] ?? "");

    if (knownTokens.length > 0) {
      // Any token of the stored name: "Hi Juan," and "Estimado Lic. García,"
      // both address Juan García.
      if (!knownTokens.includes(greetedTok)) {
        fail(
          "greeting_mismatch",
          `Email greets "${greeted}" but is addressed to ${input.recipientFullName} <${input.recipientEmail}>.`,
        );
      }
    } else if (isRoleBasedEmail(input.recipientEmail ?? "")) {
      // info@/ventas@ has no person behind it — greeting a name is invention.
      fail(
        "greeting_not_a_name",
        `Email greets "${greeted}" but ${input.recipientEmail} is a role inbox with no known person.`,
      );
    } else if (!localPart.includes(greetedTok) && greetedTok.length > 0) {
      // No stored name: the greeting must at least be derivable from the address.
      fail("greeting_mismatch", `Email greets "${greeted}" but nothing in ${input.recipientEmail} supports that name.`);
    }
  }

  // ── 3. Claims about their website need a verified fetch ──────────────────
  const makesWebsiteClaim = WEBSITE_CLAIM_PATTERNS.some((re) => re.test(both));
  if (makesWebsiteClaim && (!input.websiteVerified || !input.domain)) {
    fail(
      "unverifiable_website_claim",
      "Email characterises the prospect's website, but we never successfully fetched it. " +
        "This is the acadianlogworks.com failure — do not assert what we didn't see.",
    );
  }

  // ── 4. Company name must match what the site calls itself ────────────────
  if (input.siteName && !namesAgree(input.companyName, input.siteName)) {
    fail("company_name_unverified", `Stored name "${input.companyName}" doesn't match the site's own name "${input.siteName}".`);
  }

  // ── 5. Every number must be sourceable ───────────────────────────────────
  // Subject and body, every match, spelled-out multiples too. Sources: the
  // prospect's own evidence and active, human-verified benchmarks. Rünna's own
  // facts (30 seconds, 12 years…) are allowlisted in content-rules.
  const unsourced = findUnsourcedNumbers(both, {
    sources: [...input.evidenceQuotes, ...(input.benchmarkFigures ?? [])],
    companyName: input.companyName,
  });
  if (unsourced.length > 0) {
    fail(
      "unsourced_metric",
      `States ${unsourced.map((n) => `"${n}"`).join(", ")}, which matches no stored evidence for this ` +
        `prospect and no verified benchmark. Numbers must be sourceable.`,
    );
  }

  // ── 6. No unresolved template tokens ─────────────────────────────────────
  // A literal "{hunter_url}" reached a live draft on 2026-07-22. resolveCtaLink
  // now fills it, so anything still here — {company}, [the pain] — is a
  // placeholder the recipient would read as-is. One character counts too: the
  // exemplar scrubber emits [n], and a model may copy it (2026-10-17).
  const placeholder = both.match(/[{[]{1,2}\s*[a-záéíóúñü_' ]{1,40}?\s*[}\]]{1,2}/i);
  if (placeholder) {
    fail("unresolved_placeholder", `Contains the literal placeholder "${placeholder[0]}" — it was never substituted.`);
  }

  // ── 7. The CTA must actually render as a button ──────────────────────────
  // buildHtmlBody only makes a button from a line that starts with 👉 AND holds
  // an http(s) URL.
  const hasUrl = /https?:\/\//.test(input.body);
  if (hasUrl && !input.body.includes("👉")) {
    fail("broken_cta", "Body has a link but no 👉 marker, so it renders as plain text and the CTA button disappears.");
  }

  // ── 8. Sanity ────────────────────────────────────────────────────────────
  if (input.body.trim().length < 80) fail("empty_body", "Body is too short to be a real pitch.");
  if (input.subject.trim().length < 3) fail("missing_subject", "Subject is empty.");

  // ── 9. Never a client, never an internal product ─────────────────────────
  // The greeting line is skipped: it holds the recipient's name, and some
  // client names are first names (Lila, Niki).
  const withoutGreeting = `${input.subject}\n${input.body.trim().split("\n").slice(1).join("\n")}`;
  const clients = findClientNames(withoutGreeting, input.clientNames ?? [], [
    input.companyName,
    input.siteName,
    input.recipientFullName,
    ...input.evidenceQuotes,
  ]);
  if (clients.length > 0) {
    fail("client_name", `Names ${clients.join(", ")}. Cold emails never name a client (Pedro, 2026-07-22).`);
  }
  const internal = findInternalNames(both, [input.companyName, input.siteName, ...input.evidenceQuotes]);
  if (internal.length > 0) {
    fail("internal_name", `Names ${internal.join(", ")}: an internal product, never mentioned to a prospect.`);
  }

  // ── 10. Words: jargon, hype, the other language; no em dashes ────────────
  const terms = findBannedTerms(both, input.lang, input.companyName);
  if (terms.length > 0) {
    fail("banned_jargon", `Uses ${terms.map((t) => `"${t.trim()}"`).join(", ")}. Say the plain thing instead.`);
  }
  if (/—/.test(both)) {
    fail("em_dash", "Contains an em dash (—). Use a comma or a period.");
  }

  return failures.length === 0 ? { pass: true } : { pass: false, failures };
}
