// Auto-fill case_study_pain_tags by asking Claude Haiku to score each
// (case_study, pain) pair from 0.0–1.0. Pairs with strength ≥ 0.4 get
// inserted; existing pairs are skipped.
//
// Cost: ~20 cases × 15 pains = 300 evaluations. Haiku at ~$0.0003 each
// ≈ $0.10 total for the whole tenant.
//
// Usage:
//   cd /Users/work/Projects/S.P.A.M/.claude/worktrees/pensive-wilson-3cc368
//   export $(grep -v '^#' .env.local | xargs)
//   node scripts/audit-case-pain-tags.mjs            # dry-run, print only
//   node scripts/audit-case-pain-tags.mjs --apply    # actually insert
//
// Idempotent: re-running won't duplicate. Pairs already in the table
// are not re-scored (run with --rescore-all to override).

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(".env.local", "utf8")
  .split("\n")
  .reduce((a, l) => {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) a[m[1]] = m[2];
    return a;
  }, {});

const TENANT = "11111111-1111-1111-1111-111111111111";
const APPLY = process.argv.includes("--apply");
const RESCORE_ALL = process.argv.includes("--rescore-all");
const STRENGTH_FLOOR = 0.4; // pairs at or above this get inserted

const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const anthro = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
  timeout: 15_000,
});

console.log(`Mode: ${APPLY ? "APPLY (will insert)" : "DRY-RUN (no DB changes)"}`);
console.log(`Strength floor for insert: ${STRENGTH_FLOOR}`);
console.log(`Rescore existing: ${RESCORE_ALL ? "yes" : "no"}\n`);

// Load active case studies (rich context for accurate scoring) + pains
const { data: cases, error: caseErr } = await supa
  .from("case_studies")
  .select(
    "id, client_name, industry, hero_metric_en, result_description_en, testimonial_quote_en, measurable_results",
  )
  .eq("tenant_id", TENANT)
  .eq("is_active", true);
if (caseErr) {
  console.error("case_studies load failed:", caseErr.message);
  process.exit(1);
}

const { data: pains, error: painErr } = await supa
  .from("pain_taxonomy")
  .select("id, code, display_name_en, description_en, evidence_phrases_en")
  .eq("tenant_id", TENANT)
  .eq("is_active", true);
if (painErr) {
  console.error("pain_taxonomy load failed:", painErr.message);
  process.exit(1);
}

// Existing tags so we don't re-score them
const { data: existingTags } = await supa
  .from("case_study_pain_tags")
  .select("case_study_id, pain_id, strength");
const existing = new Map();
for (const t of existingTags ?? []) {
  existing.set(`${t.case_study_id}:${t.pain_id}`, Number(t.strength));
}

console.log(`Loaded: ${cases.length} cases × ${pains.length} pains = ${cases.length * pains.length} pairs`);
console.log(`Already tagged: ${existing.size} pairs`);

const SYSTEM = `You score how well a case study addresses a specific business pain.

Return a single number from 0.0 to 1.0:
- 1.0 = case study DIRECTLY solves this pain (clear evidence in the result_description)
- 0.7-0.9 = case clearly addresses the same problem family
- 0.4-0.6 = case is adjacent / could be referenced but isn't the strongest match
- 0.1-0.3 = case is loosely related (same industry but different problem)
- 0.0 = case has nothing to do with this pain

Be honest. A packaging-design case is NOT a strong match for a checkout-flow pain
even if both are "design work." A brand-refresh case is NOT a strong match for
email-deliverability. Same-industry alone is NOT enough.

Respond with ONLY the number. No prose. No JSON. No quotes. Just the number.`;

let scored = 0;
let toInsert = [];
let totalCostUsd = 0;
const HAIKU = "claude-haiku-4-5";

for (const cs of cases) {
  for (const pain of pains) {
    const key = `${cs.id}:${pain.id}`;
    if (existing.has(key) && !RESCORE_ALL) continue;

    const userMsg = `CASE STUDY:
Client: ${cs.client_name}
Industry: ${cs.industry ?? "(unknown)"}
Hero metric: ${cs.hero_metric_en ?? "(none)"}
Result description: ${cs.result_description_en ?? "(none)"}
Testimonial: ${cs.testimonial_quote_en ?? "(none)"}

PAIN:
Code: ${pain.code}
Display name: ${pain.display_name_en}
Description: ${pain.description_en ?? "(none)"}
Evidence phrases that signal this pain: ${(pain.evidence_phrases_en ?? []).join("; ") || "(none)"}

Score this case study's relevance to the pain (0.0–1.0):`;

    let resp;
    try {
      resp = await anthro.messages.create({
        model: HAIKU,
        max_tokens: 10,
        system: SYSTEM,
        messages: [{ role: "user", content: userMsg }],
      });
    } catch (err) {
      console.warn(`  ⨯ ${cs.client_name} × ${pain.code}: ${err.message}`);
      continue;
    }

    const text = resp.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    const score = Number.parseFloat(text);
    // Haiku 4.5 pricing: $1/M input, $5/M output
    const costUsd =
      (resp.usage.input_tokens / 1_000_000) * 1 +
      (resp.usage.output_tokens / 1_000_000) * 5;
    totalCostUsd += costUsd;
    scored++;

    if (!Number.isFinite(score) || score < 0 || score > 1) {
      console.warn(`  ⚠ ${cs.client_name} × ${pain.code}: bad score "${text}"`);
      continue;
    }

    const verdict = score >= STRENGTH_FLOOR ? "✓" : "·";
    process.stdout.write(`${verdict} ${cs.client_name.padEnd(22)} × ${pain.code.padEnd(28)} ${score.toFixed(2)}\n`);

    if (score >= STRENGTH_FLOOR) {
      toInsert.push({
        case_study_id: cs.id,
        pain_id: pain.id,
        strength: Math.round(score * 100) / 100,
      });
    }
  }
}

console.log(`\nScored: ${scored} pairs`);
console.log(`Above floor (≥${STRENGTH_FLOOR}): ${toInsert.length}`);
console.log(`Total cost: $${totalCostUsd.toFixed(4)}`);

if (!APPLY) {
  console.log("\nDry-run complete. Re-run with --apply to insert into case_study_pain_tags.");
  process.exit(0);
}

if (toInsert.length === 0) {
  console.log("\nNothing to insert.");
  process.exit(0);
}

// Insert with onConflict do-nothing — schema is `primary key (case_study_id, pain_id)`.
const { error: insertErr } = await supa
  .from("case_study_pain_tags")
  .upsert(toInsert, { onConflict: "case_study_id,pain_id" });
if (insertErr) {
  console.error("\ninsert failed:", insertErr.message);
  process.exit(1);
}
console.log(`\n✓ inserted/upserted ${toInsert.length} tags`);
