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

/** Why a pitch was held. Shown to the human, so it must name the fix. */
export type GateFailure = {
  code:
    | "unusable_email"
    | "unverified_recipient"
    | "greeting_mismatch"
    | "greeting_not_a_name"
    | "company_name_unverified"
    | "unverifiable_website_claim"
    | "unsourced_metric"
    | "unresolved_placeholder"
    | "broken_cta"
    | "empty_body";
  /** Human-readable, specific enough to act on without opening the code. */
  detail: string;
};

export type GateInput = {
  subject: string;
  body: string;
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
  /** Evidence quotes stored on the prospect — the only sourceable claims. */
  evidenceQuotes: string[];
};

export type GateResult =
  | { pass: true }
  | { pass: false; failures: GateFailure[] };

/**
 * Contact provenance we trust enough to send WITHOUT a human.
 *
 * Excluded on purpose: 'snapverify_catchall_guess' is a firstname@domain guess
 * kept only because a catch-all domain can't hard-bounce — it may reach nobody.
 * A guess is fine for a human to approve; it is not fine to auto-send.
 */
const VERIFIED_PROVENANCE = new Set([
  "snapverify_smtp",
  "anymail",
  "hunter",
  "manual",
  "scraper", // scraped from the prospect's own site, and SMTP-screened on insert
]);

/** Words that must never appear as a "first name" in a greeting. */
const NON_NAME_GREETINGS = new Set(["there", "team", "equipo", "hola", "hi", "hello"]);

/**
 * Claims about the prospect's website. If we never fetched the site, the email
 * must not characterise it — that is exactly the Acadian failure.
 */
const WEBSITE_CLAIM_PATTERNS: RegExp[] = [
  /\byour (?:website|site|web ?site)\b/i,
  /\b(?:website|site) (?:is|isn't|is not|looks|seems|appears)\b/i,
  /\bchecked your\b/i,
  /\brevis[eé] tu\b/i,
  /\btu (?:sitio|p[áa]gina)\b/i,
  /\bsu (?:sitio|p[áa]gina)\b/i,
];

/** A bare number that reads as a result claim (percentages, money, multiples). */
const METRIC_PATTERN = /\b\d+(?:[.,]\d+)?\s*(?:%|percent|x\b)|\$\s?\d|\b\d+\s?(?:k|mil|million|millones)\b/i;

/** First token of a name, lowercased. */
function firstToken(s: string): string {
  return s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** Strip accents so "José" matches "jose". */
function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Pull the greeted name out of the first line: "Hi Mark," / "Hola Miguel,".
 * Returns null when the greeting addresses a company/team rather than a person.
 */
export function extractGreetedName(body: string): string | null {
  const firstLine = body.trim().split("\n")[0] ?? "";
  const m = firstLine.match(/^\s*(?:hi|hello|hey|hola|buenos d[ií]as)\s+([^,\n]+),/i);
  if (!m) return null;
  const greeted = (m[1] ?? "").trim();
  // "Hi Acme team," / "Hola equipo de Acme," address the company, not a person.
  if (/\b(team|equipo)\b/i.test(greeted)) return null;
  const tok = firstToken(greeted);
  if (!tok || NON_NAME_GREETINGS.has(tok)) return null;
  return greeted;
}

/**
 * Decide whether a pitch may be sent without a human reading it.
 *
 * Every rule is a claim we can defend to the recipient. When in doubt the gate
 * HOLDS — a held pitch costs Pedro thirty seconds; a wrong one costs a lead.
 */
export function evaluateSendGate(input: GateInput): GateResult {
  const failures: GateFailure[] = [];

  // ── 1. Recipient must be real and trusted ────────────────────────────────
  if (!hasUsableEmail(input.recipientEmail)) {
    failures.push({
      code: "unusable_email",
      detail: `Recipient "${input.recipientEmail ?? "(none)"}" fails the usable-email check.`,
    });
  } else if (!VERIFIED_PROVENANCE.has(input.recipientSelectedBy ?? "")) {
    failures.push({
      code: "unverified_recipient",
      detail:
        `Address came from "${input.recipientSelectedBy ?? "unknown"}" — not a verified source. ` +
        `Guessed addresses may reach nobody; approve manually or re-enrich.`,
    });
  }

  // ── 2. The greeting must name the ACTUAL recipient ───────────────────────
  const greeted = extractGreetedName(input.body);
  if (greeted) {
    const greetedTok = fold(firstToken(greeted));
    const known = input.recipientFullName ? fold(firstToken(input.recipientFullName)) : null;
    const localPart = fold((input.recipientEmail ?? "").split("@")[0] ?? "");

    if (known) {
      if (greetedTok !== known) {
        failures.push({
          code: "greeting_mismatch",
          detail: `Email greets "${greeted}" but is addressed to ${input.recipientFullName} <${input.recipientEmail}>.`,
        });
      }
    } else if (isRoleBasedEmail(input.recipientEmail ?? "")) {
      // info@/ventas@ has no person behind it — greeting a name is invention.
      failures.push({
        code: "greeting_not_a_name",
        detail: `Email greets "${greeted}" but ${input.recipientEmail} is a role inbox with no known person.`,
      });
    } else if (!localPart.includes(greetedTok) && greetedTok.length > 0) {
      // No stored name: the greeting must at least be derivable from the address.
      failures.push({
        code: "greeting_mismatch",
        detail: `Email greets "${greeted}" but nothing in ${input.recipientEmail} supports that name.`,
      });
    }
  }

  // ── 3. Claims about their website need a verified fetch ──────────────────
  const makesWebsiteClaim = WEBSITE_CLAIM_PATTERNS.some(
    (re) => re.test(input.body) || re.test(input.subject),
  );
  if (makesWebsiteClaim && (!input.websiteVerified || !input.domain)) {
    failures.push({
      code: "unverifiable_website_claim",
      detail:
        "Email characterises the prospect's website, but we never successfully fetched it. " +
        "This is the acadianlogworks.com failure — do not assert what we didn't see.",
    });
  }

  // ── 4. Company name must match what the site calls itself ────────────────
  if (input.siteName) {
    const a = fold(input.companyName).replace(/[^a-z0-9]/g, "");
    const b = fold(input.siteName).replace(/[^a-z0-9]/g, "");
    // Substring either way tolerates "Acme" vs "Acme Inc." / "Acme | Home".
    if (a.length >= 3 && b.length >= 3 && !a.includes(b) && !b.includes(a)) {
      failures.push({
        code: "company_name_unverified",
        detail: `Stored name "${input.companyName}" doesn't match the site's own name "${input.siteName}".`,
      });
    }
  }

  // ── 5. Numbers in the body must be sourceable ────────────────────────────
  // A metric is allowed when it appears in stored evidence; otherwise the model
  // produced it and we cannot stand behind it.
  const metric = input.body.match(METRIC_PATTERN);
  if (metric) {
    const haystack = fold(input.evidenceQuotes.join(" "));
    const token = fold(metric[0]).trim();
    if (token && !haystack.includes(token)) {
      failures.push({
        code: "unsourced_metric",
        detail: `Body states "${metric[0].trim()}" which appears in no stored evidence for this prospect.`,
      });
    }
  }

  // ── 6. No unresolved template tokens ─────────────────────────────────────
  // A literal "{hunter_url}" reached a live draft on 2026-07-22: the composer's
  // CTA examples contained the token, the model copied it verbatim, and nothing
  // substituted it. resolveCtaLink now fills it, so anything still here is a
  // placeholder the recipient would read as-is — the most obviously broken
  // thing an email can contain.
  const placeholder = input.body.match(/[{[]{1,2}\s*[a-z_]{3,30}\s*[}\]]{1,2}/i);
  if (placeholder) {
    failures.push({
      code: "unresolved_placeholder",
      detail: `Body contains the literal placeholder "${placeholder[0]}" — it was never substituted.`,
    });
  }

  // ── 7. The CTA must actually render as a button ──────────────────────────
  // buildHtmlBody only makes a button from a line that starts with 👉 AND holds
  // an http(s) URL. Both failed in the same draft, so the reader got a plain
  // sentence with a placeholder where the button should have been.
  const hasUrl = /https?:\/\//.test(input.body);
  if (hasUrl && !input.body.includes("👉")) {
    failures.push({
      code: "broken_cta",
      detail: "Body has a link but no 👉 marker, so it renders as plain text and the CTA button disappears.",
    });
  }

  // ── 8. Sanity ────────────────────────────────────────────────────────────
  if (input.body.trim().length < 80) {
    failures.push({ code: "empty_body", detail: "Body is too short to be a real pitch." });
  }

  return failures.length === 0 ? { pass: true } : { pass: false, failures };
}
