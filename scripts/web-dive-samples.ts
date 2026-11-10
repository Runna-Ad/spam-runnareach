/**
 * Runs the web dive for real on the prospects given as arguments and prints
 * every candidate fact the model returned: kept (with its page, quote, kind
 * and page date) or dropped (with the keep-check's reason), then the check a
 * draft runs before using a kept fact (lib/research/web-dive/usable.ts: still
 * about this prospect, still recent, the page still loads), plus each dive's
 * cost. Nothing is saved and nothing is sent: the prospect rows are only
 * read, no web_research row is written, and the cost is printed, not recorded
 * in cost_tracking (so it does not count toward the app's daily cap). Each
 * dive is one real, paid Claude call with web search (about $0.19-0.22 with
 * Sonnet and 4 searches, measured 2026-11-09); the page checks are plain
 * fetches, free.
 *
 * It needs the keys in .env.local (Supabase service role for the read,
 * ANTHROPIC_API_KEY for the call), so Pedro runs it from the main checkout:
 *   node --env-file=.env.local --experimental-strip-types scripts/web-dive-samples.ts <prospect-id> [<prospect-id> ...]
 * Optional: WEB_DIVE_MODEL=claude-haiku-4-5 in front of it to try another model.
 *
 * Grade every line marked "WOULD REACH A DRAFT": open its page and check the
 * quote is there, is about this business, and is fit to say to them.
 */

import { ANTHROPIC_DEFAULT_MODEL } from "../lib/anthropic/client.ts";
import { defaultCreate } from "../lib/benchmarks/research.ts";
import { runDive, type DiveProspect } from "../lib/research/web-dive/dive.ts";
import { usableWebFacts } from "../lib/research/web-dive/usable.ts";
import { createServiceRoleClient } from "../lib/supabase/service-role.ts";

const ids = process.argv.slice(2).filter((a) => /^[0-9a-f-]{36}$/i.test(a));
if (ids.length === 0) {
  console.error("Usage: node --env-file=.env.local --experimental-strip-types scripts/web-dive-samples.ts <prospect-id> [...]");
  process.exit(1);
}
const model = process.env.WEB_DIVE_MODEL?.trim() || ANTHROPIC_DEFAULT_MODEL;

const { data, error } = await createServiceRoleClient()
  .from("prospects")
  .select("id, tenant_id, company_name, city, region, country_code, domain, website_url, industry, status")
  .in("id", ids);
if (error) {
  console.error(`prospects read failed: ${error.message || "no message"}`);
  process.exit(1);
}
const rows = (data ?? []) as Array<DiveProspect & { status: string }>;
for (const id of ids) if (!rows.some((r) => r.id === id)) console.log(`${id}: not found`);

let total = 0;
let keptTotal = 0;
let usableTotal = 0;
for (const p of rows) {
  console.log(`\n━━━ ${p.company_name} (${[p.city, p.region, p.country_code].filter(Boolean).join(", ") || "no place"}) · ${p.domain ?? p.website_url ?? "no site"} · status ${p.status} ━━━`);
  const usage = { came: false };
  const started = Date.now();
  const o = await runDive(p, {
    create: defaultCreate,
    model,
    recordCost: async () => {
      usage.came = true;
    },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  total += o.costUsd ?? 0;
  console.log(`outcome: ${o.status}${o.error ? ` (${o.error})` : ""} · ${o.searches} searches · $${(o.costUsd ?? 0).toFixed(4)} · ${seconds}s · ${model}${usage.came ? "" : " · no usage came back"}`);
  const check = await usableWebFacts(o.facts, p);
  keptTotal += o.facts.length;
  usableTotal += check.usable.length;
  for (const f of o.facts) {
    const used = check.usable.find((u) => u.url === f.url && u.quote === f.quote);
    const notUsed = check.dropped.find((d) => d.fact.url === f.url && d.fact.quote === f.quote);
    console.log(`  KEPT [${used?.kind ?? f.kind}] page date ${f.page_date ?? "none"} · ${used ? "WOULD REACH A DRAFT" : `not used at draft: ${notUsed?.reason ?? "?"}${notUsed?.detail ? ` (${notUsed.detail})` : ""}`}`);
    console.log(`       "${f.quote}"`);
    console.log(`       ${f.url}${f.title ? ` (${f.title})` : ""}`);
    console.log(`       (the dive's summary, never shown to the writer: ${f.fact})`);
  }
  for (const d of o.dropped) {
    console.log(`  DROPPED ${d.reason}: [${d.candidate.kind}] ${d.candidate.fact}`);
    console.log(`       "${d.candidate.quote}"`);
    console.log(`       ${d.candidate.url || "(no url)"}`);
  }
  if (o.facts.length === 0 && o.dropped.length === 0 && o.status !== "failed") console.log("  (the model returned no facts)");
}
const per = rows.length > 0 ? total / rows.length : 0;
console.log(`\nTotal: $${total.toFixed(4)} for ${rows.length} dive(s), $${per.toFixed(4)} per prospect. Kept ${keptTotal}, would reach a draft ${usableTotal}. Nothing was saved or sent.`);
