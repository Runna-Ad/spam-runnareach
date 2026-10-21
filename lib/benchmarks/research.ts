/**
 * Weekly "wanted facts" research (migration 0050, brief tasks/briefs/fact-research.md).
 *
 * pg_cron (Wed 14:20 UTC) → /api/benchmarks/research → per tenant, up to 2 of
 * the most-requested open facts → one Claude call each with the web_search
 * server tool → proposals stored as INACTIVE, UNVERIFIED benchmark rows for
 * Pedro to approve on /benchmarks. Nothing here ever activates a benchmark.
 *
 * The sourcing invariant (keepProposal) is the point of this file. Search
 * result content comes back encrypted, so the only source text we can read is
 * what the model cites. A proposal survives only if its URL is one the search
 * actually returned AND a citation from that same URL contains every digit
 * group of the figure. Its matching is deliberately its own (character scan, no
 * regex shared with the parser or the prompt), and it fails closed: anything
 * it cannot confirm is dropped with a reason.
 *
 * Time: one call per fact, client timeout 50 s; a fact starts only when ≥ 55 s
 * remain before a 105 s deadline (so at most 2 per run inside the 120 s
 * maxDuration). Each fact's rows and status are written right after its call;
 * a run killed between the two leaves the fact `open`, and the next run's
 * duplicate check sees the rows and marks it `proposed` without re-inserting.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ANTHROPIC_DEFAULT_MODEL, computeCostUsd, getClient, repairJsonStrings, type ClaudeUsage } from "../anthropic/client.ts";
import type { CostRecordInput } from "../anthropic/cost-tracking.ts";
import type { Database } from "../supabase/types.ts";
import { findUnsourcedNumbers, normalizeNumbers } from "../pitches/content-rules.ts";
import { industryFamily } from "./industry-families.ts";

type FactRow = Database["public"]["Tables"]["wanted_facts"]["Row"];
export type WantedFact = Pick<
  FactRow,
  "id" | "tenant_id" | "fact" | "pain_code" | "industry" | "market" | "status" | "request_count" | "last_requested_at" | "researched_at"
>;
export type BenchmarkProposalInsert = Database["public"]["Tables"]["benchmarks"]["Insert"];
type FactUpdate = Database["public"]["Tables"]["wanted_facts"]["Update"];

// ── Budget ──────────────────────────────────────────────────────────────────
export const FACTS_PER_TENANT = 2;
export const CALL_TIMEOUT_MS = 50_000;
export const RUN_DEADLINE_MS = 105_000;
export const MIN_REMAINING_TO_START_MS = 55_000;
/** The notification races this; vercel.json gives the route 120 s. */
export const NOTIFY_DEADLINE_MS = 115_000;
export const NO_SOURCE_RETRY_DAYS = 30;
export const MAX_PROPOSALS_PER_FACT = 3;
export const WEB_SEARCH_MAX_USES = 5;
/** Web search is billed $10 per 1,000 requests; computeCostUsd only knows tokens. */
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;
const MAX_TOKENS = 4_000;
const NOTE_MAX = 1_500;

// ── Response shape (the SDK in package.json predates the web_search tool) ────
type SearchResultItem = { url: string; title: string };
type CitationLite = { url: string; cited_text: string };
export type SearchUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What a response carries that the invariant may check. Read from the raw blocks only. */
export type ResponseEvidence = {
  results: SearchResultItem[];
  citations: CitationLite[];
  searchErrors: string[];
  /** Text after the last search result block: where the final JSON lives. */
  finalText: string;
};

export function readEvidence(content: unknown): ResponseEvidence {
  const results: SearchResultItem[] = [];
  const citations: CitationLite[] = [];
  const searchErrors: string[] = [];
  let finalText = "";
  for (const block of Array.isArray(content) ? content : []) {
    if (!isObj(block)) continue;
    if (block.type === "web_search_tool_result") {
      finalText = "";
      const c = block.content;
      // A list on success, an object on error (HTTP 200 either way).
      if (Array.isArray(c)) {
        for (const r of c) {
          if (isObj(r) && r.type === "web_search_result" && str(r.url)) results.push({ url: str(r.url), title: str(r.title) });
        }
      } else if (isObj(c)) {
        searchErrors.push(str(c.error_code) || str(c.type) || "unknown search error");
      } else {
        searchErrors.push("search result missing");
      }
    } else if (block.type === "text") {
      finalText += str(block.text);
      if (Array.isArray(block.citations)) {
        for (const cit of block.citations) {
          if (isObj(cit) && str(cit.url) && str(cit.cited_text)) citations.push({ url: str(cit.url), cited_text: str(cit.cited_text) });
        }
      }
    }
  }
  return { results, citations, searchErrors, finalText };
}

// ── The sourcing invariant: own matching, coarse, fail closed ───────────────

/** Trim, drop a #fragment, drop trailing slashes. Nothing else: an unknown difference is a mismatch. */
export function normalizeUrl(url: string): string {
  let u = url.trim();
  const hash = u.indexOf("#");
  if (hash >= 0) u = u.slice(0, hash);
  while (u.endsWith("/")) u = u.slice(0, -1);
  return u;
}

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";
const isSep = (ch: string | undefined): boolean => ch === "." || ch === ",";

/**
 * Digit groups by a character scan: runs of digits, joined across a single "."
 * or "," that sits between two digits ("70.22%" → ["70.22"], "1,000" →
 * ["1.000"], "5 to 25 times" → ["5", "25"]). The separator is folded to "." so
 * "70,22" (Spanish) and "70.22" compare equal; the digits must match exactly.
 */
export function digitGroups(text: string): string[] {
  const groups: string[] = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (isDigit(ch)) cur += ch;
    else if (cur && isSep(ch) && isDigit(text[i + 1])) cur += ".";
    else if (cur) {
      groups.push(cur);
      cur = "";
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

/** Whole-group containment: "70.22" is in "70.22% of carts" but not in "170.225". */
export function containsDigitGroup(text: string, group: string): boolean {
  return digitGroups(text).includes(group);
}

const isLetter = (ch: string | undefined): boolean => ch !== undefined && ch.toLowerCase() !== ch.toUpperCase();
const isSpace = (ch: string | undefined): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\u00a0";

/**
 * Size of a scale word or suffix as a power of ten. "6.77 billion" and "6.77
 * trillion" share every digit, so the scale is part of the number. Spanish
 * "billón" is 10^12 and "mil millones" is 10^9 (read below).
 */
const SCALE_OF: ReadonlyMap<string, number> = new Map([
  ["thousand", 3], ["thousands", 3], ["k", 3], ["mil", 3],
  ["million", 6], ["millions", 6], ["m", 6], ["mm", 6], ["mn", 6], ["mdd", 6], ["millón", 6], ["millon", 6], ["millones", 6],
  ["billion", 9], ["billions", 9], ["b", 9], ["bn", 9],
  ["trillion", 12], ["trillions", 12], ["t", 12], ["tn", 12], ["billón", 12], ["billon", 12], ["billones", 12],
]);

export type NumberOccurrence = { group: string; scale: number };

/**
 * Every number in `text` with the scale that FOLLOWS it: letters glued to the
 * digits ("6.77B") or the next word ("6.77 trillion"), nothing further away, so
 * "3 billion users" elsewhere in a sentence never scales "$6.77". Runs on the
 * send gate's normalizeNumbers first, so "44K"/"44,000" and "1,200"/"1200"
 * compare equal. Scale 0 = no scale word.
 */
export function numberOccurrences(text: string): NumberOccurrence[] {
  const t = normalizeNumbers(text);
  const out: NumberOccurrence[] = [];
  const wordAt = (i: number): [string, number] => {
    let w = "";
    while (isLetter(t[i])) w += t[i++]!.toLowerCase();
    return [w, i];
  };
  let i = 0;
  while (i < t.length) {
    if (!isDigit(t[i])) {
      i++;
      continue;
    }
    let group = "";
    while (i < t.length && (isDigit(t[i]) || (isSep(t[i]) && isDigit(t[i + 1]) && group !== ""))) {
      group += isDigit(t[i]) ? t[i] : ".";
      i++;
    }
    let j = i;
    if (!isLetter(t[j])) while (isSpace(t[j])) j++;
    const [word, after] = wordAt(j);
    let scale = SCALE_OF.get(word) ?? 0;
    if (word === "mil") {
      let k = after;
      while (isSpace(t[k])) k++;
      const [next] = wordAt(k);
      if (next === "millones" || next === "millón" || next === "millon") scale = 9;
    }
    out.push({ group, scale });
  }
  return out;
}

const sameOcc = (a: NumberOccurrence, b: NumberOccurrence) => a.group === b.group && a.scale === b.scale;

/** Every number of `wanted` occurs in `text` with the same scale, in the same order ("7 in 10" is not "10 stores in 7 regions"). */
export function numbersInOrder(text: string, wanted: NumberOccurrence[]): boolean {
  const have = numberOccurrences(text);
  let i = 0;
  for (const w of wanted) {
    while (i < have.length && !sameOcc(have[i]!, w)) i++;
    if (i >= have.length) return false;
    i++;
  }
  return true;
}

/** Every number of `claim` occurs somewhere in `source` with the same scale. */
export function numbersCovered(claim: string, source: string): boolean {
  const have = numberOccurrences(source);
  return numberOccurrences(claim).every((w) => have.some((h) => sameOcc(h, w)));
}

export type DropReason =
  | "malformed"
  | "url_not_in_search_results"
  | "figure_has_no_digits"
  | "figure_not_in_citation_from_url"
  | "statistic_missing_figure"
  | "statistic_number_not_in_citation"
  | "duplicate_source_and_figure"
  | "over_limit";

export type ExistingBenchmark = { source_url: string; figure: string; wanted_fact_id: string | null; rejected_at: string | null };

const sameFigure = (a: string, b: string): boolean => {
  const ga = digitGroups(normalizeNumbers(a));
  const gb = digitGroups(normalizeNumbers(b));
  return ga.length > 0 && ga.length === gb.length && ga.every((g, i) => g === gb[i]);
};

export type CandidateCheck =
  | { keep: true; resultUrl: string; citedText: string }
  | { keep: false; reason: DropReason; existing?: ExistingBenchmark };

/**
 * Checks 1–3 of the brief, plus the statistic sentence: an APPROVED row's
 * `statistic` feeds the send-gate's allowed numbers (lib/pitches/gate.ts
 * benchmarkSources), so every number in it must come from the same citation as
 * the figure. Every branch that cannot confirm returns keep: false.
 */
export function checkCandidate(
  candidate: { source_url: string; figure: string; statistic: string },
  evidence: Pick<ResponseEvidence, "results" | "citations">,
  existing: ExistingBenchmark[],
): CandidateCheck {
  const url = normalizeUrl(candidate.source_url);
  if (!url) return { keep: false, reason: "url_not_in_search_results" };
  const result = evidence.results.find((r) => normalizeUrl(r.url) === url);
  if (!result) return { keep: false, reason: "url_not_in_search_results" };

  const figureNums = numberOccurrences(candidate.figure);
  if (figureNums.length === 0) return { keep: false, reason: "figure_has_no_digits" };
  if (!numbersInOrder(candidate.statistic, figureNums)) return { keep: false, reason: "statistic_missing_figure" };
  const forFigure = evidence.citations.filter((c) => normalizeUrl(c.url) === url && numbersInOrder(c.cited_text, figureNums));
  if (forFigure.length === 0) return { keep: false, reason: "figure_not_in_citation_from_url" };
  // Two checks, both required: our digit+scale scan (the gate skips bare years),
  // and the send gate's own rule, which also reads spelled claims ("seven in ten",
  // "twice as") and is exactly what will treat this statistic as sourced.
  const citation = forFigure.find(
    (c) => numbersCovered(candidate.statistic, c.cited_text) && findUnsourcedNumbers(candidate.statistic, { sources: [c.cited_text] }).length === 0,
  );
  if (!citation) return { keep: false, reason: "statistic_number_not_in_citation" };

  const dup = existing.find((b) => normalizeUrl(b.source_url) === url && sameFigure(b.figure, candidate.figure));
  if (dup) return { keep: false, reason: "duplicate_source_and_figure", existing: dup };

  return { keep: true, resultUrl: result.url, citedText: citation.cited_text };
}

// ── Model answer ────────────────────────────────────────────────────────────

const clip = (n: number) => (s: string) => noDashes(s).trim().slice(0, n);
/** Em and en dashes are banned project-wide (they read corporate and trip spam filters). */
function noDashes(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ", ");
}
const MARKETS = new Set(["CA", "MX", "US", "GLOBAL"]);

const proposalSchema = z.object({
  statistic: z.string().transform(clip(400)),
  figure: z.string().transform((s) => s.trim().slice(0, 40)),
  source_url: z.string().transform((s) => s.trim().slice(0, 2_000)),
  publisher: z.string().transform(clip(200)),
  published_date: z
    .string()
    .nullish()
    .transform((d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d.trim()) && !Number.isNaN(Date.parse(d.trim())) ? d.trim() : null)),
  is_vendor_sourced: z.boolean(),
  caveat: z.string().transform(clip(600)),
  industry_scope: z
    .array(z.string())
    .nullish()
    .transform((a) => (a ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 15)),
  market: z
    .string()
    .nullish()
    .transform((m) => (m && MARKETS.has(m.trim().toUpperCase()) ? m.trim().toUpperCase() : null)),
  why_solid: z.string().nullish().transform((s) => clip(400)(s ?? "")),
});
export type ModelProposal = z.output<typeof proposalSchema>;

const answerSchema = z.object({
  proposals: z.array(z.unknown()).nullish().transform((a) => a ?? []),
  no_source_reason: z.string().nullish().transform((s) => (s ? clip(400)(s) : null)),
});

export type ParsedAnswer =
  | { ok: true; proposals: Array<{ ok: true; value: ModelProposal } | { ok: false; raw: unknown }>; noSourceReason: string | null }
  | { ok: false; error: string };

/** The final JSON: the last ```json fence, else the outermost braces of the final text. */
export function parseAnswer(finalText: string): ParsedAnswer {
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
    noSourceReason: parsed.data.no_source_reason,
    proposals: parsed.data.proposals.map((raw) => {
      const p = proposalSchema.safeParse(raw);
      return p.success && p.data.statistic && p.data.figure && p.data.publisher && p.data.caveat && p.data.source_url
        ? { ok: true as const, value: p.data }
        : { ok: false as const, raw };
    }),
  };
}

// ── Prompt ──────────────────────────────────────────────────────────────────

/**
 * The industry vocabulary the model may scope a proposal to: the members of
 * lib/benchmarks/industry-families.ts (not exported there; a test checks every
 * term here maps to a family). Code drops any other term (scopeToFamilies).
 */
export const INDUSTRY_TERMS: readonly string[] = [
  "online store", "retail", "boutique", "direct to consumer", "tienda", "ecommerce", "e-commerce",
  "manufacturer", "manufacturing", "industrial supplier", "distribution", "distributor", "wholesale",
  "wholesale distributor", "supply chain", "logistics",
  "accounting firm", "chartered accountant", "despacho contable", "asesoría fiscal", "law firm",
  "despacho de abogados", "consultoría", "consulting firm", "agencia de seguros",
  "hospital", "clínica", "consultorio dental", "fisioterapia",
  "spa", "salón de belleza", "estética", "fitness studio", "gimnasio",
  "restaurant", "restaurante", "restaurant group", "bar", "panadería",
  "hotel", "hotel chain", "boutique hotel",
];

/** Keeps only terms the benchmark matcher knows (industryFamily), deduped, in order. */
export function scopeToFamilies(scope: string[]): { kept: string[]; unknown: string[] } {
  const kept: string[] = [];
  const unknown: string[] = [];
  for (const term of scope) {
    if (industryFamily(term) === null) unknown.push(term);
    else if (!kept.includes(term)) kept.push(term);
  }
  return { kept, unknown };
}

export const RESEARCH_SYSTEM = `You research statistics for a small agency's sales emails. A human reviews everything you return before it is used, and a number that the source does not state is worse than no number.

TASK: find up to ${MAX_PROPOSALS_PER_FACT} solid, citable statistics for the wanted fact the user gives you, best first. Use web search.

WHAT COUNTS AS SOLID
- Prefer government statistics offices, academic studies, large independent surveys and established research firms. State the sample, geography and year.
- A figure published by a company that sells a product related to the claim (an email, cart or software vendor, an agency) is VENDOR-SOURCED: you may return it, but set is_vendor_sourced true and say so in the caveat.
- Never estimate, combine, round or convert numbers. The figure must appear in the source text exactly as you write it (same digits, same order, same scale word such as million or billion).
- The statistic sentence may only use numbers that appear in the sentence you cited for it: no extra years, totals or second figures, and no spelled-out comparisons ("twice as", "three times", "seven in ten") unless the cited sentence says exactly that.
- If nothing solid exists, return no proposals and say why. That is a good, useful answer.

HOW TO ANSWER (two parts, in this order)
1. For each candidate, write one sentence that states the figure and cites the search result it comes from, so the citation carries the source's own words.
2. Then end with ONE fenced JSON block, nothing after it:
\`\`\`json
{"proposals": [{
  "statistic": "one diagnostic sentence, the way it would be quoted in an email, containing the figure",
  "figure": "the bare figure exactly as the source states it, e.g. 70.22%",
  "source_url": "the exact URL of the search result you cited for it",
  "publisher": "who published it (and who commissioned it, if known)",
  "published_date": "YYYY-MM-DD or null",
  "is_vendor_sourced": false,
  "caveat": "sample, geography, year, who published; anything a careful reader must know",
  "industry_scope": ["industries it legitimately applies to, ONLY from the list below; [] only if the source is truly cross-industry, and then say so in the caveat"],
  "market": "CA | MX | US | GLOBAL | null",
  "why_solid": "one sentence on why this source is credible"
}], "no_source_reason": null}
\`\`\`
Use only URLs that your searches returned. Do not use em dashes.

INDUSTRY TERMS (industry_scope may only use these, exactly as written): ${INDUSTRY_TERMS.join(", ")}.`;

export function researchUserPrompt(fact: WantedFact): string {
  const lines = [`Wanted fact: ${fact.fact}`];
  if (fact.industry) lines.push(`Asked for a prospect in: ${fact.industry}`);
  if (fact.market) lines.push(`Prospect market: ${fact.market}`);
  if (fact.pain_code) lines.push(`Pain it supports: ${fact.pain_code}`);
  return lines.join("\n");
}

// ── Cost ────────────────────────────────────────────────────────────────────

export function researchCost(model: string, usage: SearchUsage): { usage: ClaudeUsage; webSearchRequests: number } {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const webSearchRequests = Math.max(0, Math.trunc(usage.server_tool_use?.web_search_requests ?? 0));
  const tokens = computeCostUsd(model, usage.input_tokens, usage.output_tokens, cacheRead, cacheCreate);
  const cost = Math.round((tokens + webSearchRequests * WEB_SEARCH_USD_PER_REQUEST) * 1_000_000) / 1_000_000;
  return {
    webSearchRequests,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
      cost_usd: cost,
    },
  };
}

// ── Store (service-role Supabase; the route passes it) ──────────────────────

export type ResearchStore = {
  /** Up to `limit` eligible facts, request_count desc, last_requested_at desc. */
  selectFacts(tenantId: string, now: Date, limit: number): Promise<WantedFact[]>;
  existingBenchmarks(tenantId: string): Promise<ExistingBenchmark[]>;
  insertProposals(rows: BenchmarkProposalInsert[]): Promise<{ error: string | null }>;
  /** Only moves a fact that is still open/no_source (Pedro may dismiss it mid-run). */
  updateFact(tenantId: string, factId: string, patch: FactUpdate): Promise<{ error: string | null }>;
};

const FACT_COLUMNS = "id, tenant_id, fact, pain_code, industry, market, status, request_count, last_requested_at, researched_at";

type Db = {
  // A narrow structural view of the service-role client, so tests can pass a fake.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
};

const errText = (e: { message?: string } | null | undefined): string | null =>
  e ? e.message || "database error (empty message)" : null;

export function supabaseResearchStore(db: Db): ResearchStore {
  return {
    async selectFacts(tenantId, now, limit) {
      const cutoff = new Date(now.getTime() - NO_SOURCE_RETRY_DAYS * 86_400_000).toISOString();
      const [open, retry] = await Promise.all([
        db.from("wanted_facts").select(FACT_COLUMNS).eq("tenant_id", tenantId).eq("status", "open")
          .order("request_count", { ascending: false }).order("last_requested_at", { ascending: false }).limit(limit),
        db.from("wanted_facts").select(FACT_COLUMNS).eq("tenant_id", tenantId).eq("status", "no_source")
          .lt("researched_at", cutoff)
          .order("request_count", { ascending: false }).order("last_requested_at", { ascending: false }).limit(limit),
      ]);
      if (open.error) throw new Error(`wanted_facts read failed: ${errText(open.error)}`);
      if (retry.error) throw new Error(`wanted_facts read failed: ${errText(retry.error)}`);
      return orderFacts([...((open.data ?? []) as WantedFact[]), ...((retry.data ?? []) as WantedFact[])]).slice(0, limit);
    },
    async existingBenchmarks(tenantId) {
      const out: ExistingBenchmark[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await db.from("benchmarks").select("source_url, figure, wanted_fact_id, rejected_at")
          .eq("tenant_id", tenantId).order("id", { ascending: true }).range(from, from + PAGE - 1);
        if (error) throw new Error(`benchmarks read failed: ${errText(error)}`);
        out.push(...((data ?? []) as ExistingBenchmark[]));
        if ((data ?? []).length < PAGE) return out;
      }
    },
    async insertProposals(rows) {
      const { error } = await db.from("benchmarks").insert(rows);
      return { error: errText(error) };
    },
    async updateFact(tenantId, factId, patch) {
      const { error } = await db.from("wanted_facts").update(patch)
        .eq("id", factId).eq("tenant_id", tenantId).in("status", ["open", "no_source"]);
      return { error: errText(error) };
    },
  };
}

/** Selection order. Status filtering is the store's job; this re-checks it (pure, tested). */
export function eligibleFact(f: Pick<WantedFact, "status" | "researched_at">, now: Date): boolean {
  if (f.status === "open") return true;
  if (f.status !== "no_source" || !f.researched_at) return false;
  return Date.parse(f.researched_at) < now.getTime() - NO_SOURCE_RETRY_DAYS * 86_400_000;
}

export function orderFacts<T extends Pick<WantedFact, "request_count" | "last_requested_at">>(facts: T[]): T[] {
  return [...facts].sort(
    (a, b) => b.request_count - a.request_count || Date.parse(b.last_requested_at) - Date.parse(a.last_requested_at),
  );
}

// ── One fact ────────────────────────────────────────────────────────────────

export type Dropped = { source_url: string; figure: string; reason: DropReason };
export type FactOutcome = {
  fact: WantedFact;
  kind: "proposed" | "already_proposed" | "no_source" | "unfinished" | "search_error" | "parse_error" | "call_failed" | "search_disabled";
  proposals: BenchmarkProposalInsert[];
  dropped: Dropped[];
  note: string;
  costUsd: number | null;
  webSearchRequests: number;
};

export type CreateMessage = (params: Record<string, unknown>) => Promise<unknown>;

export const defaultCreate: CreateMessage = (params) =>
  // The web_search server tool is not in this SDK version's types; the request is plain JSON.
  getClient(CALL_TIMEOUT_MS).messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming);

/** "Web search is not enabled for this organization" and its variants, from a thrown error or an error code. */
export function isSearchDisabled(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("web search") || m.includes("web_search")
    ? /not (been )?enabled|disabled|not available for|not allowed|not permitted/.test(m)
    : false;
}

function noteOf(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(" ").slice(0, NOTE_MAX);
}

function describeDrops(dropped: Dropped[]): string {
  return dropped.length === 0 ? "" : `Dropped: ${dropped.map((d) => `${d.figure || "?"} (${d.source_url || "no url"}): ${d.reason}`).join("; ")}.`;
}

export type FactDeps = {
  create: CreateMessage;
  recordCost: (input: CostRecordInput) => Promise<void>;
  existing: ExistingBenchmark[];
  /** Read after the call, so proposed_at is when the answer arrived. */
  now: () => Date;
  model: string;
};

export async function researchFact(fact: WantedFact, deps: FactDeps): Promise<FactOutcome> {
  const base = { fact, proposals: [] as BenchmarkProposalInsert[], dropped: [] as Dropped[], costUsd: null as number | null, webSearchRequests: 0 };
  let raw: unknown;
  try {
    raw = await deps.create({
      model: deps.model,
      max_tokens: MAX_TOKENS,
      system: RESEARCH_SYSTEM,
      messages: [{ role: "user", content: researchUserPrompt(fact) }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX_USES }],
    });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED]");
    if (isSearchDisabled(message)) {
      return { ...base, kind: "search_disabled", note: "Not researched: web search not enabled for the Anthropic org (Claude Console)." };
    }
    return { ...base, kind: "call_failed", note: noteOf(["Research call failed, will retry next run:", message.slice(0, 300)]) };
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
    base.webSearchRequests = webSearchRequests;
    // Paid whether or not the answer is usable: record on usage, never on ok.
    await deps.recordCost({
      tenantId: fact.tenant_id,
      model: deps.model,
      entity_type: "fact_research",
      entity_id: fact.id,
      usage,
      metadata: { web_search_requests: webSearchRequests, stop_reason: stop || null },
    });
  }

  const evidence = readEvidence(res.content);
  const disabledCode = evidence.searchErrors.find(isSearchDisabled);
  if (disabledCode) {
    return { ...base, kind: "search_disabled", note: "Not researched: web search not enabled for the Anthropic org (Claude Console)." };
  }
  if (stop === "pause_turn") {
    return { ...base, kind: "unfinished", note: "Research turn paused before it finished (pause_turn); will retry next run." };
  }

  const parsed = parseAnswer(evidence.finalText);
  if (!parsed.ok) {
    const searchNote = evidence.searchErrors.length ? `Search errors: ${evidence.searchErrors.join(", ")}.` : "";
    return { ...base, kind: "parse_error", note: noteOf([`No usable answer (${parsed.error}${stop ? `, stop_reason ${stop}` : ""}); will retry next run.`, searchNote]) };
  }

  const proposedAt = deps.now().toISOString();
  const kept: BenchmarkProposalInsert[] = [];
  let alreadyProposed = 0;
  const seen: ExistingBenchmark[] = [...deps.existing];
  for (const p of parsed.proposals) {
    if (!p.ok) {
      const r = isObj(p.raw) ? p.raw : {};
      base.dropped.push({ source_url: str(r.source_url), figure: str(r.figure), reason: "malformed" });
      continue;
    }
    const v = p.value;
    const check = checkCandidate(v, evidence, seen);
    if (!check.keep) {
      if (check.reason === "duplicate_source_and_figure" && check.existing?.wanted_fact_id === fact.id && !check.existing.rejected_at) {
        alreadyProposed++;
      }
      base.dropped.push({ source_url: v.source_url, figure: v.figure, reason: check.reason });
      continue;
    }
    if (kept.length >= MAX_PROPOSALS_PER_FACT) {
      base.dropped.push({ source_url: v.source_url, figure: v.figure, reason: "over_limit" });
      continue;
    }
    // A second copy of the same source + figure in this answer is a duplicate of the first.
    seen.push({ source_url: check.resultUrl, figure: v.figure, wanted_fact_id: null, rejected_at: null });
    const scope = scopeToFamilies(v.industry_scope);
    kept.push({
      tenant_id: fact.tenant_id,
      wanted_fact_id: fact.id,
      proposed_at: proposedAt,
      is_active: false,
      verified_at: null,
      verified_by: null,
      statistic: v.statistic,
      figure: v.figure,
      pain_codes: fact.pain_code ? [fact.pain_code] : [],
      // All terms unknown → keep the model's own terms: [] would rank as universal
      // (queries.ts) and reach every prospect; raw terms only match by the direct word rule.
      industry_scope: scope.kept.length === 0 && scope.unknown.length > 0 ? scope.unknown : scope.kept,
      market: v.market,
      source_url: check.resultUrl,
      publisher: v.publisher,
      published_date: v.published_date,
      is_vendor_sourced: v.is_vendor_sourced,
      caveat: v.caveat,
      proposal_note: noteOf([
        `Cited: "${check.citedText.trim().slice(0, 600)}"`,
        v.why_solid ? `Why solid: ${v.why_solid}` : null,
        scope.kept.length > 0 && scope.unknown.length > 0 ? `Industry terms dropped (not in the benchmark families): ${scope.unknown.join(", ")}.` : null,
        scope.kept.length === 0 && scope.unknown.length > 0 ? `Industry terms kept as written (none is in the benchmark families, so they match only by the direct word rule): ${scope.unknown.join(", ")}.` : null,
        v.industry_scope.length === 0 ? "No industry scope: this would match every prospect; check the caveat says the source is cross-industry." : null,
      ]),
    });
  }

  const searchNote = evidence.searchErrors.length ? `Search errors: ${evidence.searchErrors.join(", ")}.` : "";
  if (kept.length > 0) {
    return { ...base, kind: "proposed", proposals: kept, note: noteOf([`${kept.length} proposal(s) for review on /benchmarks.`, describeDrops(base.dropped), searchNote]) };
  }
  if (alreadyProposed > 0) {
    return { ...base, kind: "already_proposed", note: noteOf(["Proposals from an earlier run already wait on /benchmarks.", describeDrops(base.dropped)]) };
  }
  if (evidence.searchErrors.length > 0 && evidence.results.length === 0) {
    return { ...base, kind: "search_error", note: noteOf(["Web search failed; will retry next run.", searchNote]) };
  }
  return {
    ...base,
    kind: "no_source",
    note: noteOf([
      `No solid source found (retry after ${NO_SOURCE_RETRY_DAYS} days).`,
      parsed.noSourceReason ? `Model: ${parsed.noSourceReason}` : null,
      describeDrops(base.dropped),
      searchNote,
    ]),
  };
}

/** The writes for one outcome: proposals first, then the fact's status (killed between = next run sees the rows). */
export async function writeOutcome(store: ResearchStore, o: FactOutcome, now: Date): Promise<{ written: number; error: string | null }> {
  const at = now.toISOString();
  const tenantId = o.fact.tenant_id;
  if (o.kind === "proposed") {
    const ins = await store.insertProposals(o.proposals);
    if (ins.error) {
      await store.updateFact(tenantId, o.fact.id, { research_note: noteOf([`Proposals not saved (${ins.error}); will retry next run.`, o.note]) });
      return { written: 0, error: ins.error };
    }
    const up = await store.updateFact(tenantId, o.fact.id, { status: "proposed", researched_at: at, research_note: o.note });
    return { written: o.proposals.length, error: up.error };
  }
  if (o.kind === "already_proposed") {
    const up = await store.updateFact(tenantId, o.fact.id, { status: "proposed", researched_at: at, research_note: o.note });
    return { written: 0, error: up.error };
  }
  if (o.kind === "no_source") {
    const up = await store.updateFact(tenantId, o.fact.id, { status: "no_source", researched_at: at, research_note: o.note });
    return { written: 0, error: up.error };
  }
  // Unfinished, failed, or search off: keep the status (and a no_source fact's 30-day clock), leave a note.
  const up = await store.updateFact(tenantId, o.fact.id, { research_note: o.note });
  return { written: 0, error: up.error };
}

// ── The run ─────────────────────────────────────────────────────────────────

export type NotifyMessage = { subject: string; body: string };

export type RunDeps = {
  store: ResearchStore;
  tenantIds: () => Promise<string[]>;
  underCap: (tenantId: string) => Promise<{ under: boolean }>;
  recordCost: (input: CostRecordInput) => Promise<void>;
  notify: (tenantId: string, message: NotifyMessage) => Promise<{ sent: number; failed: string[] }>;
  warn: (message: string) => void;
  /** Milliseconds; injectable so the budget is testable. */
  clock?: () => number;
  create?: CreateMessage;
  appUrl?: string;
};

export type RunReport = {
  ok: boolean;
  dry: boolean;
  calls: number;
  stopped: null | "cap" | "search_disabled" | "deadline";
  facts: Array<{ id: string; fact: string; kind: FactOutcome["kind"]; proposals: number; note: string; cost_usd: number | null }>;
  proposals?: BenchmarkProposalInsert[];
  dropped?: Dropped[];
  emailed: number;
  errors: string[];
};

export function formatResearchEmail(
  written: Array<{ fact: string; figure: string; publisher: string; vendor: boolean }>,
  appUrl: string,
): NotifyMessage {
  const n = written.length;
  const lines = written.map((w) => `- ${w.figure}, ${w.publisher}${w.vendor ? " (vendor-published)" : ""}. For: "${w.fact}"`);
  return {
    subject: `${n} sourced statistic${n === 1 ? "" : "s"} wait for your review`,
    body: [
      `The weekly research found ${n} statistic${n === 1 ? "" : "s"} for facts the writer asked for. None is live until you approve it.`,
      "",
      ...lines,
      "",
      `Review: ${appUrl.replace(/\/$/, "")}/benchmarks`,
    ].join("\n"),
  };
}

export async function runFactResearch(deps: RunDeps, opts: { dry: boolean }): Promise<RunReport> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const create = deps.create ?? defaultCreate;
  const report: RunReport = { ok: true, dry: opts.dry, calls: 0, stopped: null, facts: [], emailed: 0, errors: [] };
  const toEmail = new Map<string, Array<{ fact: string; figure: string; publisher: string; vendor: boolean }>>();

  let tenants: string[];
  try {
    tenants = await deps.tenantIds();
  } catch (err) {
    return { ...report, ok: false, errors: [(err as Error).message] };
  }

  run: for (const tenantId of tenants) {
    let facts: WantedFact[];
    try {
      const now = new Date(clock());
      facts = (await deps.store.selectFacts(tenantId, now, FACTS_PER_TENANT)).filter((f) => eligibleFact(f, now)).slice(0, FACTS_PER_TENANT);
    } catch (err) {
      report.errors.push(`${tenantId}: ${(err as Error).message}`);
      continue;
    }
    let existing: ExistingBenchmark[] | null = null;
    for (const fact of facts) {
      if (RUN_DEADLINE_MS - (clock() - started) < MIN_REMAINING_TO_START_MS) {
        report.stopped = "deadline";
        break run;
      }
      if (!(await deps.underCap(tenantId)).under) {
        report.stopped = "cap";
        break run;
      }
      try {
        existing ??= await deps.store.existingBenchmarks(tenantId);
      } catch (err) {
        report.errors.push(`${tenantId}: ${(err as Error).message}`);
        continue run;
      }
      report.calls++;
      const outcome = await researchFact(fact, { create, recordCost: deps.recordCost, existing, now: () => new Date(clock()), model: ANTHROPIC_DEFAULT_MODEL });
      report.facts.push({ id: fact.id, fact: fact.fact, kind: outcome.kind, proposals: outcome.proposals.length, note: outcome.note, cost_usd: outcome.costUsd });

      if (opts.dry) {
        report.proposals = outcome.proposals;
        report.dropped = outcome.dropped;
        if (outcome.kind === "search_disabled") report.stopped = "search_disabled";
        break run; // ONE fact, no writes, no email.
      }

      const w = await writeOutcome(deps.store, outcome, new Date(clock()));
      if (w.error) report.errors.push(`${tenantId}/${fact.id}: ${w.error}`);
      if (w.written > 0) {
        existing.push(...outcome.proposals.map((p) => ({ source_url: p.source_url, figure: p.figure, wanted_fact_id: fact.id, rejected_at: null })));
        const list = toEmail.get(tenantId) ?? [];
        list.push(...outcome.proposals.map((p) => ({ fact: fact.fact, figure: p.figure, publisher: p.publisher, vendor: p.is_vendor_sourced ?? false })));
        toEmail.set(tenantId, list);
      }
      if (outcome.kind === "search_disabled") {
        report.stopped = "search_disabled";
        deps.warn("S.P.A.M. fact research: web search is not enabled for the Anthropic org (Claude Console). Wanted facts stay open.");
        break run;
      }
    }
  }

  // Last step: may be cut off at maxDuration. Rows and statuses are already written.
  // Proposals inserted by a run killed before this point are never emailed later;
  // they still show on /benchmarks.
  for (const [tenantId, written] of toEmail) {
    const remaining = NOTIFY_DEADLINE_MS - (clock() - started);
    if (remaining <= 0) {
      report.errors.push(`${tenantId}: no time left for the notification`);
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        deps.notify(tenantId, formatResearchEmail(written, deps.appUrl ?? "https://spam-runnareach.vercel.app")),
        new Promise<{ sent: number; failed: string[] }>((resolve) => {
          timer = setTimeout(() => resolve({ sent: 0, failed: ["notification timed out"] }), remaining);
        }),
      ]);
      report.emailed += res.sent;
      report.errors.push(...res.failed.map((f) => `${tenantId}: ${f}`));
    } catch (err) {
      report.errors.push(`${tenantId}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return report;
}

export async function handleFactResearch(
  req: Request,
  deps: RunDeps & { authorize: (req: Request) => Promise<boolean> },
): Promise<Response> {
  if (!(await deps.authorize(req))) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const report = await runFactResearch(deps, { dry });
  return Response.json(report, { status: report.ok ? 200 : 500 });
}
