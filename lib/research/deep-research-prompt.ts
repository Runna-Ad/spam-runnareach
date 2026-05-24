/**
 * Pedro's deep-research prompt template.
 * Kept in a separate (non-server) file so it can be imported by both the
 * server action (deep-research-action.ts) and the client component that
 * builds the "Copy Prompt" clipboard string.
 *
 * When `taxonomy` is provided, Claude is asked to tag each pain point with
 * the canonical pain_id so it maps directly to the dropdown — no post-hoc
 * string matching needed.
 */

export type TaxonomyEntry = { id: string; display_name_en: string };

export function buildDeepResearchPrompt(
  companyName: string,
  url: string,
  taxonomy?: TaxonomyEntry[],
): string {
  const painInstruction =
    taxonomy && taxonomy.length > 0
      ? `Tag each pain using this EXACT format on a single line:
[ID: <canonical_id>] Short pain description | Evidence: "exact phrase from the research context above"

Rules:
- canonical_id MUST be one of the IDs listed below. Use [ID: none] if no ID fits.
- The evidence quote MUST be a verbatim sentence or phrase from the RESEARCH CONTEXT — not invented.
- If you cannot find an actual quote from the context, write Evidence: "(inferred — no direct quote)" instead of making one up.
- No multi-line format. Each pain = one line exactly as shown above.

Canonical pain IDs:
${taxonomy.map((t) => `- ${t.id}: ${t.display_name_en}`).join("\n")}`
      : `One line each. Use this format:
Pain description | Evidence: "exact phrase from the research context above"
If no direct quote exists, write Evidence: "(inferred)"`;

  return `Analyze ${companyName} at ${url} as a sales prospect for Rünna

Search their website, social media, reviews, and any public intel.
Return ONLY this structure — be brutally concise:

**COMPANY SNAPSHOT**
- What they do / size / locations / ownership
- Current agency relationships (if any)
- Tech stack signals

**TOP 5 PAIN POINTS** (ranked by pitch urgency)
${painInstruction}

**TOP 3 OPPORTUNITIES FOR US**
Which service do we lead with and why? (marketing, AI, or both)

**ELEVATOR PITCH HOOK**
One punchy paragraph. What's the single strongest angle to open with?

**WHO TO CONTACT**
Name/title of decision-maker if findable.

No fluff. No headers beyond these. Skip anything not actionable.`;
}
