/**
 * Claude AI Search — agentic lead discovery.
 *
 * Unlike the other sources (which hit a single directory/API and return whatever
 * matches a keyword), this source hands Claude a `brave_search` tool and an ICP
 * brief, then lets it run its own research loop: search → read snippets → decide
 * what to search next → extract only the businesses that genuinely fit the ICP.
 *
 * Why this is worth the extra cost:
 *   - Claude reads and *understands* result snippets, so it filters out
 *     directories, listicles, and off-ICP businesses before they ever reach
 *     the pipeline (instead of relying on regex blocklists).
 *   - It can chain searches ("yoga studios Calgary" → "boutique fitness Calgary"
 *     → "youth athletic training Calgary") to surface businesses a single
 *     keyword query would miss.
 *   - Extraction (name, site, city) happens during discovery, not as a
 *     separate scrape pass.
 *
 * Cost model: Claude does the *thinking*, Brave does the *searching*. Brave is
 * 2,000 free queries/month and the agent makes ~3-8 searches per run, so the
 * marginal cost is just Claude tokens (~$0.01-0.05 per run on Sonnet).
 *
 * Requires BOTH ANTHROPIC_API_KEY and BRAVE_SEARCH_API_KEY.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  getClient,
  claudeIsAvailable,
  ANTHROPIC_DEFAULT_MODEL,
  computeCostUsd,
} from "@/lib/anthropic/client";
import { normalizeDomain } from "../fuzzy-dedupe";
import { searchBrave, braveIsAvailable } from "./brave-search";

// ── Public types ─────────────────────────────────────────────────────────────

export type ClaudeSearchListing = {
  company_name: string;
  website_url: string | null;
  domain: string | null;
  city: string | null;
  region: string | null;
};

/** ICP context the agent uses to judge fit — all optional, more is better. */
export type ClaudeSearchIcp = {
  name: string;
  industry_tags: string[];
  business_types: string[];
  geo_regions: string[];
  employee_size_min: number | null;
  employee_size_max: number | null;
  excluded_keywords: string[];
};

export type ClaudeSearchInput = {
  /** Natural-language brief / keyword from the user (e.g. "boutique fitness studios"). */
  brief: string;
  /** Location hint (e.g. "Calgary, AB" or "Alberta, Canada"). */
  location: string;
  /** Country for the underlying Brave calls. */
  country?: "CA" | "MX" | "US";
  /** Optional ICP context — sharpens the fit judgement. */
  icp?: ClaudeSearchIcp | null;
  /** How many businesses to aim for. Default 15. */
  target?: number;
};

export type ClaudeSearchResult =
  | { ok: true; listings: ClaudeSearchListing[]; searches_run: number; cost_usd: number }
  | { ok: false; error: string };

// ── Availability ──────────────────────────────────────────────────────────────

export function claudeSearchIsAvailable(): boolean {
  return claudeIsAvailable() && braveIsAvailable();
}

// ── Tool definition (the agent's only tool) ───────────────────────────────────

const BRAVE_TOOL: Anthropic.Tool = {
  name: "brave_search",
  description:
    "Search the live web via Brave. Returns up to 20 results, each with a " +
    "title, url, and description snippet. Use this to find candidate " +
    "businesses, then read the snippets to judge whether each one fits the " +
    "target customer profile. Run multiple searches with different angles " +
    "(synonyms, neighbourhoods, niches) to widen coverage.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'The search query, e.g. "boutique fitness studios Calgary" or ' +
          '"youth soccer academy Edmonton". Keep it natural, like a customer would type.',
      },
    },
    required: ["query"],
  },
};

// Hard caps so a single run can't blow the Vercel function budget or Brave quota.
const MAX_SEARCHES = 8;
const MAX_TURNS = 10;

// ── Final-answer schema ───────────────────────────────────────────────────────

const listingSchema = z.object({
  company_name: z.string().trim().min(1).max(200),
  website_url: z.string().trim().nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  region: z.string().trim().max(60).nullable().optional(),
});
const finalSchema = z.object({
  businesses: z.array(listingSchema).max(50),
});

// ── Entry point ───────────────────────────────────────────────────────────────

export async function searchWithClaude(
  input: ClaudeSearchInput,
): Promise<ClaudeSearchResult> {
  if (!claudeIsAvailable()) {
    return { ok: false, error: "ANTHROPIC_API_KEY not set" };
  }
  if (!braveIsAvailable()) {
    return { ok: false, error: "BRAVE_SEARCH_API_KEY not set" };
  }

  const country = input.country ?? "CA";
  const target = Math.min(Math.max(input.target ?? 15, 1), 40);
  const client = getClient();

  const system = buildSystemPrompt(input, target);

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Find up to ${target} real businesses matching the profile in "${input.location}". ` +
        `Start brief: "${input.brief}". Use the brave_search tool to research, then ` +
        `return your final answer as JSON.`,
    },
  ];

  let searchesRun = 0;
  let totalInput = 0;
  let totalOutput = 0;
  // Every domain Brave actually showed the model. The final answer is
  // whitelisted against this set — an LLM can emit a plausible-looking domain
  // it never saw, and an unverified domain on a prospect ends up in outreach.
  const seenDomains = new Set<string>();

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.messages.create({
        model: ANTHROPIC_DEFAULT_MODEL,
        max_tokens: 2048,
        system,
        tools: [BRAVE_TOOL],
        messages,
      });

      totalInput += response.usage.input_tokens;
      totalOutput += response.usage.output_tokens;

      // Collect any tool_use blocks this turn.
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        // Claude is done — parse its final text answer.
        const text = response.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
          .trim();
        const listings = parseFinalAnswer(text, seenDomains);
        const cost_usd = computeCostUsd(ANTHROPIC_DEFAULT_MODEL, totalInput, totalOutput);
        if (!listings) {
          return {
            ok: false,
            error: "Claude did not return parseable results. Try a more specific brief.",
          };
        }
        return { ok: true, listings, searches_run: searchesRun, cost_usd };
      }

      // Keep the assistant turn (with its tool_use blocks) in the history.
      messages.push({ role: "assistant", content: response.content });

      // Execute each requested search and feed results back.
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        if (searchesRun >= MAX_SEARCHES) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content:
              "Search budget reached. Do not call brave_search again — " +
              "return your final JSON answer now using what you've found.",
          });
          continue;
        }
        const query = extractQuery(tu.input);
        if (!query) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "Invalid query. Provide a non-empty 'query' string.",
            is_error: true,
          });
          continue;
        }
        searchesRun++;
        const brave = await searchBrave({ query, country, count: 20 });
        if (brave.ok) {
          for (const l of brave.listings) {
            if (l.domain) seenDomains.add(l.domain);
          }
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: brave.ok ? formatBraveResults(brave.listings) : `Search failed: ${brave.error}`,
          is_error: !brave.ok,
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    // Ran out of turns without a final answer.
    const cost_usd = computeCostUsd(ANTHROPIC_DEFAULT_MODEL, totalInput, totalOutput);
    console.warn(`[claude-search] hit MAX_TURNS without final answer (cost $${cost_usd})`);
    return {
      ok: false,
      error: "AI search ran out of steps before finishing. Try a narrower brief.",
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSystemPrompt(input: ClaudeSearchInput, target: number): string {
  const icp = input.icp;
  const lines: string[] = [
    "You are a B2B lead researcher. Your job is to find real businesses that " +
      "match a target customer profile (ICP), using the brave_search tool.",
    "",
    "TARGET CUSTOMER PROFILE:",
    `- Looking for: ${input.brief}`,
    `- Location: ${input.location}`,
  ];
  if (icp) {
    lines.push(`- ICP name: ${icp.name}`);
    if (icp.industry_tags.length) lines.push(`- Industries: ${icp.industry_tags.join(", ")}`);
    if (icp.business_types.length) lines.push(`- Business types: ${icp.business_types.join(", ")}`);
    if (icp.geo_regions.length) lines.push(`- Preferred regions: ${icp.geo_regions.join(", ")}`);
    if (icp.employee_size_min || icp.employee_size_max) {
      lines.push(
        `- Company size: ${icp.employee_size_min ?? "any"}–${icp.employee_size_max ?? "any"} employees`,
      );
    }
    if (icp.excluded_keywords.length) {
      lines.push(`- EXCLUDE businesses matching: ${icp.excluded_keywords.join(", ")}`);
    }
  }
  lines.push(
    "",
    "RULES:",
    `- Aim for up to ${target} distinct businesses that genuinely fit. Quality over quantity — a tight list of 8 real fits beats 20 loose ones.`,
    "- Only include actual businesses with their OWN website. Skip directories, " +
      "marketplaces (Yelp, YellowPages, Amazon, Etsy), social profiles, news " +
      "articles, listicles, and aggregators.",
    "- Skip web/marketing/SEO agencies and SaaS platforms — those are vendors, not prospects.",
    "- Run several searches from different angles to widen coverage before answering.",
    `- You may run at most ${MAX_SEARCHES} searches. Spend them wisely.`,
    "",
    "When done, respond with ONLY a JSON object (no prose, no markdown fences):",
    '{ "businesses": [ { "company_name": "...", "website_url": "https://...", "city": "...", "region": "..." } ] }',
    "Use null for website_url, city, or region if genuinely unknown. region is a " +
      "province/state code where possible (e.g. \"AB\").",
  );
  return lines.join("\n");
}

function extractQuery(raw: unknown): string | null {
  if (raw && typeof raw === "object" && "query" in raw) {
    const q = (raw as { query?: unknown }).query;
    if (typeof q === "string" && q.trim().length > 0) return q.trim();
  }
  return null;
}

function formatBraveResults(
  listings: Array<{ company_name: string; website_url: string; description: string | null }>,
): string {
  if (listings.length === 0) return "No results.";
  return listings
    .map(
      (l, i) =>
        `${i + 1}. ${l.company_name}\n   ${l.website_url}\n   ${l.description ?? "(no snippet)"}`,
    )
    .join("\n");
}

function parseFinalAnswer(text: string, seenDomains: Set<string>): ClaudeSearchListing[] | null {
  // Be lenient — strip code fences and grab the outermost JSON object.
  let cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  // If there's leading/trailing prose, isolate the {...} block.
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first > 0 || last < cleaned.length - 1) {
    if (first !== -1 && last !== -1 && last > first) {
      cleaned = cleaned.slice(first, last + 1);
    }
  }

  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const parsed = finalSchema.safeParse(json);
  if (!parsed.success) return null;

  return parsed.data.businesses.map((b) => {
    let website = b.website_url?.trim() || null;
    let domain: string | null = null;
    if (website) {
      try {
        domain = normalizeDomain(new URL(website.startsWith("http") ? website : `https://${website}`).hostname);
      } catch {
        domain = null;
      }
    }
    // Whitelist against the Brave results the model actually saw. A domain it
    // never saw is (at best) a guess and (at worst) a hallucination — blank it
    // so the pipeline's verified website-discovery handles it instead of
    // storing an unvetted URL that could reach a sent pitch.
    if (domain && !seenDomains.has(domain)) {
      website = null;
      domain = null;
    }
    return {
      company_name: b.company_name.trim(),
      website_url: website,
      domain,
      city: b.city?.trim() || null,
      region: b.region?.trim() || null,
    };
  });
}
