/**
 * Proven facts: the only things an email may say about a prospect
 * (Pedro, 2026-11-09, after CrushCamp's hard no: "whatever we claim we are
 * 100% sure its correct and if not default to offering services in general").
 *
 * A proven fact has a source we hold: the page it is on, and for a web fact
 * the exact text on that page (lib/research/web-dive, checked in code before
 * it is stored). What is NOT here, on purpose:
 *   - absences ("no contact form was found"): the crawler reads a few pages
 *     and can't see apps, so "we didn't find it" is never sure. CrushCamp was
 *     told its site had no phone setting; it had one.
 *   - "seen" facts that carry an absence inside them ("the only way to book
 *     we saw is by phone").
 *   - research pains and the research pitch hook: our own AI wrote them.
 *
 * `hook` says what the fact can carry in an email: "problem" (something not
 * working, said by a measurement or by the business or its customers),
 * "opening" (a change that makes them likely to need help), "context"
 * (true and useful, but no reason to write). A problem-led first email needs
 * at least one problem or opening; otherwise the capability email goes out.
 *
 * Pure: zero server imports.
 */

import type { GeneratorInputs } from "./generator.ts";
import type { SiteFact } from "./site-facts.ts";

export type ProvenHook = "problem" | "opening" | "context";

/** The web-dive's stored fact (lib/research/web-dive/facts.ts WebFact), structurally. */
export type WebFactInput = {
  fact: string;
  quote: string;
  url: string;
  title: string | null;
  kind: ProvenHook;
};

export type ProvenFact = {
  source: "site" | "web";
  /** The check it came from (site) or "web". */
  id: string;
  fact: string;
  url: string;
  /** The exact text on the page (web facts); null for site facts, whose `fact` is our wording of what the crawler saw. */
  quote: string | null;
  hook: ProvenHook;
};

const HOOKS: ReadonlySet<string> = new Set(["problem", "opening", "context"]);

function siteHook(f: SiteFact): ProvenHook {
  // A measurement Google itself rates as poor is a problem we can show.
  if (f.id === "psi" && /which Google rates as poor$/.test(f.fact)) return "problem";
  return "context";
}

/** A "seen" site fact whose wording still claims an absence. */
function carriesAbsence(f: SiteFact): boolean {
  return /^The only way\b/i.test(f.fact) || /\bonly\b.*\bwe saw\b/i.test(f.fact);
}

export function provenFacts(input: {
  site_facts?: readonly SiteFact[] | null;
  web_facts?: readonly WebFactInput[] | null;
}): ProvenFact[] {
  const site = (input.site_facts ?? [])
    .filter((f) => f.kind === "seen" && f.strength === "strong" && !carriesAbsence(f))
    .map((f): ProvenFact => ({ source: "site", id: f.id, fact: f.fact, url: f.url, quote: null, hook: siteHook(f) }));
  const web = (input.web_facts ?? [])
    .filter((f) => f.fact.trim() && f.quote.trim() && /^https?:\/\//i.test(f.url) && HOOKS.has(f.kind))
    .map((f): ProvenFact => ({ source: "web", id: "web", fact: f.fact.trim(), url: f.url, quote: f.quote.trim(), hook: f.kind }));
  return [...site, ...web];
}

/** At least one fact that gives a reason to write about THEIR situation. */
export function hasProvenHook(facts: readonly ProvenFact[]): boolean {
  return facts.some((f) => f.hook !== "context");
}

/**
 * The writer's inputs with only what we can prove about the prospect: the ONE
 * place every drafting path (first draft, rewrite with an angle) passes
 * through, so the writer, the AI reviewer and the writing gate all see the
 * same list. Research pains are dropped (their evidence_quote was the
 * research step's own sentence for CrushCamp); site facts keep only proven
 * "seen" entries; web facts come from the web dive; what_they_do loses its
 * guesses; with no pain there are no benchmarks either (a figure is only
 * cited for the pain the email leads with). Everything else is unchanged.
 */
export function proveInputs(inputs: GeneratorInputs, webFacts: readonly WebFactInput[] | null | undefined): GeneratorInputs {
  const proven = provenFacts({ site_facts: inputs.site_facts, web_facts: webFacts });
  const provenSite = new Set(proven.filter((f) => f.source === "site").map((f) => `${f.id}\n${f.fact}`));
  // "Rewrite with this angle": a person picked the angle, so its pain stays as
  // a direction for the offer, without the research's evidence text.
  const angleId = inputs.forced_angle?.pain_id ?? null;
  const pains = angleId ? inputs.pains.filter((p) => p.pain_id === angleId).map((p) => ({ ...p, evidence_quote: null })) : [];
  return {
    ...inputs,
    prospect: { ...inputs.prospect, what_they_do: cleanWhatTheyDo(inputs.prospect.what_they_do) },
    pains,
    // A figure is cited only for the pain the email leads with: no pain, no figure (FACTS 2).
    benchmarks: pains.length > 0 ? inputs.benchmarks : [],
    site_facts: (inputs.site_facts ?? []).filter((f) => provenSite.has(`${f.id}\n${f.fact}`)),
    web_facts: proven.filter((f) => f.source === "web").map((f) => ({ fact: f.fact, quote: f.quote ?? "", url: f.url, title: null, kind: f.hook })),
  };
}

// ── what_they_do without the research step's guesses ──────────────────────────

// A clause that guesses, judges or reports a "not visible" is our research's
// opinion, not what they do. CrushCamp's read "likely single-location
// independent; Squarespace site suggests small operator No visible agency
// relationships detected Tech: Squarespace, …".
const GUESS = new RegExp(
  [
    String.raw`\b(likely|unlikely|probably|possibly|perhaps|apparently|presumably|seems?|appears?|suggests?|implies|indicates?|may|might|could)\b`,
    String.raw`\bno (visible|apparent|clear|obvious)\b`, String.raw`\bnot (visible|apparent|detected)\b`, String.raw`\bdetected\b`,
    String.raw`\b(basic|outdated|limited|lacks?|lacking|missing|weak|poor)\b`,
    // Judgments about their site ("Website looks dated"). Not "old": "Old Town" is a place.
    String.raw`\b(looks?|dated|aging|clunky)\b`,
    // Fails closed (second review, 2026-11-09): a negation or a limiter is an
    // absence in disguise ("bookings by phone only", "Doesn't offer online
    // booking", "Sin reservaciones en línea"), and a pain, an opportunity, an
    // estimate or a would/should is the research's opinion, never what they do.
    String.raw`\b(no|not|without|only|lacks?|missing|never|none)\b`, String.raw`n['’]t\b`,
    String.raw`\b(sin|s[oó]lo|falta|faltan|nunca|ning[uú]n[oa]?)(?![\p{L}])`, String.raw`\bno hay\b`,
    String.raw`\bpains?\s*:`, String.raw`opportunit`, String.raw`\bbenefit`, String.raw`\bestimat(?:ed|e|ion)\b`, String.raw`\bapprox`,
    String.raw`\b(would|should)\b`, String.raw`\b(podr[ií]an?|deber[ií]an?)(?![\p{L}])`,
    String.raw`\b(probablemente|posiblemente|aparentemente|parece|sugiere|indica|quiz[aá]s|tal vez)\b`,
    String.raw`\bno (se ve|se observa|visible|aparente)\b`, String.raw`\b(b[aá]sic[oa]|limitad[oa]|obsolet[oa]|carece|falta)\b`,
  ].join("|"),
  "iu",
);

/**
 * The parts of what_they_do that only say what the business does. Splits on
 * sentence ends, semicolons and the scraper's "Tech:" tail; drops every part
 * that guesses or judges. Nothing left → null.
 */
export function cleanWhatTheyDo(text: string | null | undefined): string | null {
  if (!text) return null;
  const head = text.split(/\bTech(?:nolog(?:y|ías?))?\s*:/i)[0] ?? "";
  const parts = head
    .replace(/\s+/g, " ")
    // "Approx. 10 employees" is one clause: an abbreviation's dot ends no sentence.
    .replace(/\b(approx|aprox|est|ca)\.\s*/gi, "$1 ")
    // "…detected Tech: …" and "…operator No visible…" run sentences together: split before a capitalised "No ".
    .split(/(?<=[.;!?])\s+|;\s*|\s+(?=No\s)/)
    .map((p) => p.trim().replace(/[.;,]+\s*$/, ""))
    .filter((p) => p.length > 0 && !GUESS.test(p));
  const out = parts.join("; ").trim();
  return out.length >= 3 ? out : null;
}
