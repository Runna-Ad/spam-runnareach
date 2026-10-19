/**
 * SPAM Verify — our own recipient verifier, at zero cost.
 *
 * Paid verifiers probe the recipient's mail server over SMTP (port 25), which
 * Vercel and Supabase block. Instead this combines what we CAN know for free:
 *
 *   1. format      — the existing usable-address gate (glue, placeholders, TLDs)
 *   2. never-pitch — privacy/HR/careers/volunteer/no-reply desks, regulators
 *   3. DNS         — the domain exists and accepts mail (MX, or A fallback;
 *                    a null MX or a missing domain can only bounce)
 *   4. ownership   — the address belongs to the prospect's own domain
 *   5. provenance  — published on their site > verified finder > guess;
 *                    a finder's address (Anymail, Hunter) is never "send"
 *   6. memory      — a domain that already hard-bounced on us only gets
 *                    addresses the company itself publishes
 *
 * What our 26 historical bounces were (prod, Jun–Aug 2026): 15 junk text and
 * 1 wrong-company domain, all caught by 1–4; 7 dead mailboxes on real domains
 * and 2 policy blocks, which 5–6 narrow but no free check can fully prove.
 *
 * Verdicts: "send" (safe to send unattended), "review" (a human must approve —
 * fine for today's manual flow, never auto-sent), "drop" (never send).
 * The pure core is unit-tested in tests/verify-recipient.test.ts.
 */

import { Resolver } from "node:dns/promises";
import { hasUsableEmail, isNeverPitchEmail, isRegulatorEmail } from "./email-utils.ts";

export type Verdict = "send" | "review" | "drop";
export type Provenance = "high" | "medium" | "low";
export type DnsStatus = "mx" | "a_only" | "no_mail" | "null_mx" | "nxdomain" | "unknown";

export type VerifyResult = {
  verdict: Verdict;
  provenance: Provenance;
  reasons: string[];
};

export type VerifyInput = {
  email: string;
  /** prospect_contacts.selected_by — how we got the address. */
  selectedBy: string | null;
  /** The prospect's website domain, if known. */
  prospectDomain: string | null;
  /** Registrable domains that already hard-bounced on us. */
  bouncedDomains: ReadonlySet<string>;
};

/** Second-level public suffixes we meet in CA / MX (and a few common others). */
const TWO_LEVEL_SUFFIXES = new Set([
  "com.mx", "org.mx", "net.mx", "edu.mx", "gob.mx",
  "ab.ca", "bc.ca", "mb.ca", "nb.ca", "nl.ca", "ns.ca", "nt.ca", "nu.ca", "on.ca", "pe.ca", "qc.ca", "sk.ca", "yk.ca",
  "co.uk", "org.uk", "com.au", "net.au", "com.br", "co.nz",
]);

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.es", "outlook.com", "outlook.es", "live.com", "live.com.mx",
  "yahoo.com", "yahoo.com.mx", "yahoo.ca", "icloud.com", "me.com", "aol.com", "protonmail.com", "proton.me",
  "prodigy.net.mx", "shaw.ca", "telus.net", "rogers.com", "sympatico.ca", "bell.net",
]);

/** "mail.acme.com.mx" → "acme.com.mx"; "www.acme.ca" → "acme.ca". */
export function registrableDomain(host: string): string {
  const labels = host.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** Where the address came from decides how much we trust it. */
export function provenanceOf(selectedBy: string | null): Provenance {
  switch (selectedBy) {
    case "manual": // a person typed it
    case "scraper": // the company publishes it on its own site
      return "high";
    case "anymail":
    case "hunter":
      return "medium"; // a finder that verifies against its own data
    case "engine": // Claude's pick from research notes
    case "snapverify": // pattern guess; the SMTP probe can't run (port 25 blocked)
    case "snapverify_catchall_guess":
      return "low";
    default:
      return "medium";
  }
}

/**
 * Finder services (paid lookups) infer an address from name patterns and their
 * own data; the company never published it. On 2026-10-19, 1 of 9 Anymail
 * sends hard-bounced (1 of 39 scraped ones did), so a finder's address goes
 * to a person and never out automatically.
 */
const FINDER_SOURCES: ReadonlySet<string> = new Set(["anymail", "hunter"]);

export function isFinderSource(selectedBy: string | null | undefined): boolean {
  return FINDER_SOURCES.has((selectedBy ?? "").trim().toLowerCase());
}

/** How long a stored verdict (prospect_contacts.verify_verdict) is reused before it is checked again. */
export const VERDICT_TTL_MS = 7 * 86_400_000;

/**
 * May a stored verdict be reused instead of verifying again? Within the TTL,
 * except a stored "send" for a finder address: that was stored before finder
 * addresses needed a person, and today's rules would not give it.
 */
export function storedVerdictUsable(
  c: { verdict: Verdict | null; checkedAt: string | null; selectedBy: string | null },
  now: Date,
): boolean {
  if (!c.verdict || !c.checkedAt) return false;
  const age = now.getTime() - Date.parse(c.checkedAt);
  if (!(age < VERDICT_TTL_MS)) return false;
  return !(c.verdict === "send" && isFinderSource(c.selectedBy));
}

export function verifyEmailPure(input: VerifyInput, dns: DnsStatus): VerifyResult {
  const email = input.email.trim().toLowerCase();
  const provenance = provenanceOf(input.selectedBy);
  const drop: string[] = [];
  const review: string[] = [];

  if (!hasUsableEmail(email)) drop.push("Not a usable address (malformed, placeholder or glued text)");
  if (isNeverPitchEmail(email)) drop.push("A department that never buys (privacy, HR, careers, volunteer, no-reply…)");
  if (isRegulatorEmail(email)) drop.push("A regulator or government address");

  const domain = email.split("@")[1] ?? "";
  const reg = registrableDomain(domain);

  switch (dns) {
    case "nxdomain":
      drop.push(`${domain} doesn't exist`);
      break;
    case "null_mx":
      drop.push(`${domain} declares it accepts no email (null MX)`);
      break;
    case "no_mail":
      drop.push(`${domain} has no mail server (no MX, no A record)`);
      break;
    case "a_only":
      review.push(`${domain} has no MX record (mail would go to its web server)`);
      break;
    case "unknown":
      review.push(`Couldn't check ${domain}'s DNS`);
      break;
    case "mx":
      break;
  }

  if (input.bouncedDomains.has(reg) && provenance !== "high") {
    drop.push(`${reg} already hard-bounced on us — only addresses the company publishes are tried there`);
  }

  if (FREEMAIL.has(domain)) {
    // Many SMBs (MX especially) really do run on gmail/hotmail — fine when
    // they publish it themselves, a guess otherwise.
    if (provenance !== "high") review.push(`Free-mail address (${domain}) not published by the company`);
  } else if (!input.prospectDomain) {
    review.push("The prospect has no website domain to match the address against");
  } else if (registrableDomain(input.prospectDomain) !== reg) {
    review.push(`Address domain ${reg} isn't the prospect's site (${registrableDomain(input.prospectDomain)})`);
  }

  if (provenance === "low") review.push(`Guessed address (${input.selectedBy ?? "unknown source"}) — not proven to exist`);
  // Provenance stays "medium", so the bounced-domain rule above still drops it.
  if (isFinderSource(input.selectedBy)) {
    review.push(`Address from a finder service (${input.selectedBy}), not published by the company`);
  }

  const verdict: Verdict = drop.length > 0 ? "drop" : review.length > 0 ? "review" : "send";
  return { verdict, provenance, reasons: [...drop, ...review] };
}

// ── DNS ────────────────────────────────────────────────────────────────────────

export type MxResolver = {
  resolveMx(hostname: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
};

function code(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? "";
}

/** Domains that always have MX — a control query proving the resolver works. */
const CANARY_DOMAINS = ["gmail.com", "outlook.com"];
const CANARY_TTL_MS = 5 * 60 * 1000;
const canaryCache = new WeakMap<MxResolver, { healthy: boolean; at: number }>();
let defaultResolver: MxResolver | null = null;

/**
 * Is this resolver actually answering? A broken resolver (no network, sandbox,
 * misconfigured DNS) answers ENOTFOUND for EVERYTHING — gmail.com included —
 * and without this check every recipient would be declared nonexistent and
 * the whole queue dropped. Same lesson as the Spamhaus false positive: run a
 * control query before believing a scary answer.
 */
async function resolverIsHealthy(r: MxResolver): Promise<boolean> {
  const cached = canaryCache.get(r);
  if (cached && Date.now() - cached.at < CANARY_TTL_MS) return cached.healthy;
  let healthy = false;
  for (const canary of CANARY_DOMAINS) {
    try {
      if ((await r.resolveMx(canary)).length > 0) {
        healthy = true;
        break;
      }
    } catch {
      // try the next canary
    }
  }
  canaryCache.set(r, { healthy, at: Date.now() });
  return healthy;
}

/**
 * Can this domain receive mail? System resolver (never pinned to public DNS —
 * see the Spamhaus lesson), short timeout, and only DEFINITE answers from a
 * resolver that passes the control query become nxdomain / null_mx / no_mail;
 * anything flaky is "unknown".
 */
export async function checkDomainMail(domain: string, resolver?: MxResolver): Promise<DnsStatus> {
  const r: MxResolver = resolver ?? (defaultResolver ??= new Resolver({ timeout: 3000, tries: 2 }));
  let status: DnsStatus | null = null;
  try {
    const mx = await r.resolveMx(domain);
    if (mx.length === 1 && (mx[0]?.exchange === "" || mx[0]?.exchange === ".")) status = "null_mx";
    else if (mx.length > 0) return "mx";
  } catch (err) {
    const c = code(err);
    if (c === "ENOTFOUND") status = "nxdomain";
    else if (c !== "ENODATA") return "unknown";
  }
  if (status === null) {
    // No MX: RFC 5321 falls back to the A/AAAA record.
    for (const lookup of [r.resolve4.bind(r), r.resolve6.bind(r)]) {
      try {
        if ((await lookup(domain)).length > 0) return "a_only";
      } catch (err) {
        const c = code(err);
        if (c !== "ENODATA" && c !== "ENOTFOUND") return "unknown";
      }
    }
    status = "no_mail";
  }
  // A negative answer only counts if the resolver can see domains that exist.
  return (await resolverIsHealthy(r)) ? status : "unknown";
}

// ── With the database ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Verify a recipient against DNS and our own bounce history. */
export async function verifyRecipient(
  supabase: AnySupabase,
  args: { tenantId: string; email: string; selectedBy: string | null; prospectDomain: string | null },
  resolver?: MxResolver,
): Promise<VerifyResult> {
  const domain = args.email.trim().toLowerCase().split("@")[1] ?? "";
  const reg = registrableDomain(domain);

  const bouncedDomains = new Set<string>();
  if (reg) {
    const { data } = await supabase
      .from("do_not_contact_list")
      .select("email")
      .eq("tenant_id", args.tenantId)
      .eq("entry_type", "bounced")
      .ilike("email", `%${likeLiteral(reg)}`);
    for (const row of (data ?? []) as Array<{ email: string | null }>) {
      const d = row.email?.split("@")[1];
      if (d && registrableDomain(d) === reg) bouncedDomains.add(reg);
    }
  }

  const dns = domain ? await checkDomainMail(domain, resolver) : "unknown";
  const result = verifyEmailPure(
    { email: args.email, selectedBy: args.selectedBy, prospectDomain: args.prospectDomain, bouncedDomains },
    dns,
  );

  // Keep the verdict on the contact row(s) for this address, so its trust is
  // visible without re-running the check. Best effort: a failed write must
  // never change the verdict or block the send.
  try {
    await supabase
      .from("prospect_contacts")
      .update({
        verify_verdict: result.verdict,
        verify_reasons: result.reasons,
        verify_checked_at: new Date().toISOString(),
      })
      .eq("tenant_id", args.tenantId)
      .ilike("email", likeLiteral(args.email.trim()));
  } catch {
    /* evidence, not a dependency */
  }

  return result;
}
