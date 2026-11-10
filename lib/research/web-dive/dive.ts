/**
 * One web dive: one Claude call with the web_search server tool, asking for
 * facts about one prospect from pages other than its own website, then the
 * keep-check (keep.ts) on every candidate. The request is plain JSON and the
 * response is read from its raw blocks, the way weekly fact research does
 * (lib/benchmarks/research.ts: readEvidence, researchCost, isSearchDisabled).
 *
 * Outcomes:
 *   ok      the search ran and 1+ facts were kept
 *   empty   the search ran and nothing was kept ("we looked, found nothing": cached 60 days)
 *   failed  the call threw or timed out, pause_turn, no search ran, search
 *           errors only, an unparseable answer, or web search disabled
 * Cost is recorded whenever usage came back, whatever the outcome.
 */

import { z } from "zod";
import { repairJsonStrings } from "../../anthropic/client.ts";
import {
  isSearchDisabled,
  readEvidence,
  researchCost,
  type CreateMessage,
  type SearchUsage,
} from "../../benchmarks/research.ts";
import { MAX_WEB_FACTS, type WebFact } from "./facts.ts";
import { keepWebFacts, type DroppedCandidate, type KeepProspect, type WebFactCandidate } from "./keep.ts";
import { SEARCH_BLOCKED_DOMAINS } from "./match.ts";

/** The server tool's uses per dive (the brief: 4 searches ≈ $0.20-0.22 with Sonnet). */
export const WEB_DIVE_MAX_USES = 4;
const MAX_TOKENS = 4_000;
const ERROR_MAX = 500;

export type DiveProspect = KeepProspect & {
  id: string;
  tenant_id: string;
  region: string | null;
  country_code: string | null;
  industry: string | null;
};

export type DiveStatus = "ok" | "empty" | "failed";

export type DiveOutcome = {
  status: DiveStatus;
  facts: WebFact[];
  dropped: DroppedCandidate[];
  searches: number;
  costUsd: number | null;
  model: string;
  error: string | null;
  /** Web search is off for the Anthropic org: the run stops (every dive would fail the same way). */
  searchDisabled: boolean;
};

/** The cost_tracking entity_type every dive records, and the one the dive's own 24h ceiling reads (route.ts). */
export const WEB_DIVE_COST_ENTITY = "web_research" as const;

/** What a dive records in cost_tracking (entity_type is the web dive's own). */
export type WebDiveCostInput = {
  tenantId: string;
  model: string;
  entity_type: typeof WEB_DIVE_COST_ENTITY;
  entity_id: string | null;
  usage: ReturnType<typeof researchCost>["usage"];
  metadata?: Record<string, unknown>;
};

export type DiveDeps = {
  create: CreateMessage;
  recordCost: (input: WebDiveCostInput) => Promise<void>;
  model: string;
  /** The clock the page dates are judged against (tests). */
  now?: () => Date;
};

// ── Prompt ───────────────────────────────────────────────────────────────────

export const WEB_DIVE_SYSTEM = `You research one small business for a sales email from a small agency. Every claim in that email must be 100% correct, so a fact you cannot quote from a page is worse than no fact.

TASK: use web search to find facts about THIS business from pages other than its own website: reviews, local news, job posts, directories, social profiles, awards, new locations. Do not use pages on its own domain; we read its website separately.

ONLY THIS BUSINESS
- A fact counts only if the page is clearly about this exact business: the same name AND the same city, or a link to its website.
- A business with the same or a similar name in another city is a different business. Leave it out.
- A page that lists many businesses (a "best of" list, a directory page) counts only for the words about this one.
- Never guess, infer, combine or round. "No facts" is a good, useful answer.

SOURCES WE NEVER USE
- Employee reviews and pages about working there (Indeed company pages, Glassdoor, salary pages): they are about the job, not the business.
- Pages written by a machine from scraped data: business-data profiles and directories that summarise a company (ZoomInfo, Tracxn, Birdeye, Wheree, Cylex, Canpages, Crunchbase and the like), and their FAQ or "about this company" text.
- A problem or an opening must come from a page dated in the last year. An old article or an expired job post is not an opening.

EACH FACT
- url: the exact URL of the search result it comes from.
- quote: words copied exactly from that page, 20 to 150 characters, that show the fact AND name the business. No ellipsis, no edits. The email may say only what the quote says.
- fact: one plain sentence saying what the quote shows. Use no number the quote does not contain.
- kind: "problem" (something the business or its customers say is not working, e.g. a review saying nobody answers the phone, a post about a booking outage), "opening" (a change that makes them likely to need help: a new location, hiring front-desk or marketing staff, a launch, an award) or "context" (anything else true and useful: what they offer, where, since when).

HOW TO ANSWER (two parts, in this order)
1. For each fact, write one sentence that cites the search result it comes from, so the citation carries the page's own words.
2. Then end with ONE fenced JSON block, nothing after it:
\`\`\`json
{"facts": [{"fact": "one sentence", "quote": "exact words from the page", "url": "https://...", "kind": "problem"}], "no_facts_reason": null}
\`\`\`
At most ${MAX_WEB_FACTS} facts, best first. Use only URLs your searches returned. Do not use em dashes.`;

export function webDiveUserPrompt(p: DiveProspect): string {
  const lines = [`Business: ${p.company_name}`];
  const place = [p.city, p.region, p.country_code].filter((x): x is string => !!x && !!x.trim()).join(", ");
  if (place) lines.push(`Location: ${place}`);
  const site = p.domain?.trim() || p.website_url?.trim();
  if (site) lines.push(`Its own website (do not use it): ${site}`);
  if (p.industry?.trim()) lines.push(`Industry: ${p.industry.trim()}`);
  return lines.join("\n");
}

// ── Answer ───────────────────────────────────────────────────────────────────

const clip = (n: number) => (s: string) => s.trim().slice(0, n);
const candidateSchema = z.object({
  fact: z.string().transform(clip(400)),
  // A prefix of a quoted passage is still in the citation, so clipping can't make a quote pass.
  quote: z.string().transform(clip(600)),
  url: z.string().transform(clip(2_000)),
  kind: z.string().transform((s) => s.trim().toLowerCase()),
});
const answerSchema = z.object({ facts: z.array(z.unknown()).nullish().transform((a) => a ?? []) });

export type ParsedDive =
  | { ok: true; candidates: Array<{ ok: true; value: WebFactCandidate } | { ok: false; raw: unknown }> }
  | { ok: false; error: string };

/** The final JSON: the last ```json fence, else the outermost braces. Parsed by a parser, never a regex. */
export function parseDiveAnswer(finalText: string): ParsedDive {
  const text = finalText.trim();
  let body = "";
  const fence = text.lastIndexOf("```json");
  if (fence >= 0) {
    const start = fence + "```json".length;
    const end = text.indexOf("```", start);
    body = (end >= 0 ? text.slice(start, end) : text.slice(start)).trim();
  } else {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    body = a >= 0 && b > a ? text.slice(a, b + 1) : "";
  }
  if (!body) return { ok: false, error: "no JSON in the final answer" };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    try {
      json = JSON.parse(repairJsonStrings(body));
    } catch {
      return { ok: false, error: "final JSON did not parse" };
    }
  }
  const parsed = answerSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: "final JSON has the wrong shape" };
  return {
    ok: true,
    candidates: parsed.data.facts.map((raw) => {
      const c = candidateSchema.safeParse(raw);
      return c.success ? { ok: true as const, value: c.data } : { ok: false as const, raw };
    }),
  };
}

// ── One dive ─────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const redact = (s: string) => s.replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED]").slice(0, ERROR_MAX);

function malformed(raw: unknown): DroppedCandidate {
  const r = isObj(raw) ? raw : {};
  return {
    candidate: { fact: str(r.fact).slice(0, 400), quote: str(r.quote).slice(0, 600), url: str(r.url).slice(0, 500), kind: str(r.kind).slice(0, 40) },
    reason: "malformed",
  };
}

export async function runDive(
  prospect: DiveProspect,
  deps: DiveDeps,
  opts: { researchId?: string | null } = {},
): Promise<DiveOutcome> {
  const base: DiveOutcome = { status: "failed", facts: [], dropped: [], searches: 0, costUsd: null, model: deps.model, error: null, searchDisabled: false };
  let raw: unknown;
  try {
    raw = await deps.create({
      model: deps.model,
      max_tokens: MAX_TOKENS,
      system: WEB_DIVE_SYSTEM,
      messages: [{ role: "user", content: webDiveUserPrompt(prospect) }],
      // blocked_domains only saves searches; keep.ts drops those sources whatever the search returns.
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_DIVE_MAX_USES, blocked_domains: [...SEARCH_BLOCKED_DOMAINS] }],
    });
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    if (isSearchDisabled(message)) return { ...base, searchDisabled: true, error: `web search not enabled: ${message}` };
    return { ...base, error: `call failed: ${message || "no message"}` };
  }

  const res = isObj(raw) ? raw : {};
  const stop = str(res.stop_reason);
  if (isObj(res.usage)) {
    const u = res.usage as unknown as SearchUsage;
    const { usage, webSearchRequests } = researchCost(deps.model, {
      ...u,
      input_tokens: Number(u.input_tokens) || 0,
      output_tokens: Number(u.output_tokens) || 0,
    });
    base.costUsd = usage.cost_usd;
    base.searches = webSearchRequests;
    // Paid whether or not the answer is usable: record on usage, never on ok.
    await deps.recordCost({
      tenantId: prospect.tenant_id,
      model: deps.model,
      entity_type: WEB_DIVE_COST_ENTITY,
      entity_id: opts.researchId ?? null,
      usage,
      metadata: { prospect_id: prospect.id, web_search_requests: webSearchRequests, stop_reason: stop || null },
    });
  }

  const evidence = readEvidence(res.content);
  const disabled = evidence.searchErrors.find(isSearchDisabled);
  if (disabled) return { ...base, searchDisabled: true, error: `web search not enabled: ${disabled}` };
  if (stop === "pause_turn") return { ...base, error: "pause_turn: the turn paused before it finished" };
  if (base.searches === 0 && evidence.results.length === 0) {
    return { ...base, error: evidence.searchErrors.length ? `search errors: ${evidence.searchErrors.join(", ")}` : "no search ran" };
  }
  if (evidence.results.length === 0 && evidence.searchErrors.length > 0) {
    return { ...base, error: `search errors: ${evidence.searchErrors.join(", ")}`.slice(0, ERROR_MAX) };
  }

  const parsed = parseDiveAnswer(evidence.finalText);
  if (!parsed.ok) return { ...base, error: `${parsed.error}${stop ? ` (stop_reason ${stop})` : ""}` };

  const dropped: DroppedCandidate[] = [];
  const candidates: WebFactCandidate[] = [];
  for (const c of parsed.candidates) {
    if (c.ok) candidates.push(c.value);
    else dropped.push(malformed(c.raw));
  }
  const checked = keepWebFacts(candidates, evidence, prospect, deps.now?.() ?? new Date());
  dropped.push(...checked.dropped);
  return { ...base, status: checked.kept.length > 0 ? "ok" : "empty", facts: checked.kept, dropped, error: null };
}
