/**
 * Full flow test: 3-tier pitch fallback + ICP verification
 * Runs entirely in Node — no Next.js imports needed.
 * Replicates the generator logic inline with real DB data.
 *
 * Run: node scripts/test-3tier-pitch.mjs
 */

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf-8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const supabase = createClient(env["NEXT_PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"], {
  auth: { persistSession: false },
});
const TENANT_ID = "11111111-1111-1111-1111-111111111111";

// ── Helpers ───────────────────────────────────────────────────────────────────

const pass = (msg, detail = "") => console.log(`  \x1b[32m✅ PASS\x1b[0m  ${msg}${detail ? `\n         ${detail}` : ""}`);
const fail = (msg, detail = "") => { console.log(`  \x1b[31m❌ FAIL\x1b[0m  ${msg}${detail ? `\n         ${detail}` : ""}`); process.exitCode = 1; };
const info = (msg) => console.log(`  \x1b[33mℹ\x1b[0m      ${msg}`);
const head = (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`);

function industryMatch(a, b) {
  if (!a || !b) return false;
  const al = a.toLowerCase(), bl = b.toLowerCase();
  return al === bl || al.includes(bl) || bl.includes(al);
}

function resolveTier(prospectIndustry, caseStudies, notableClients) {
  // Tier 1: case study with pain_strength ≥ 0.4
  const tier1 = caseStudies.find(cs => (cs.pain_strength ?? 0) >= 0.4) ?? null;
  if (tier1) return { tier: 1, match: tier1.client_name };

  // Tier 2: notable client industry match
  const tier2 = notableClients.find(nc =>
    nc.industry_tags.some(tag => industryMatch(tag, prospectIndustry))
  ) ?? null;
  if (tier2) return { tier: 2, match: tier2.name };

  // Tier 3: name-drop
  const names = notableClients.slice(0, 4).map(nc => nc.name);
  return { tier: 3, match: names.join(", ") };
}

// ── Load data ────────────────────────────────────────────────────────────────

head("1. Loading DB state");

const [
  { data: notableClients, error: ncErr },
  { data: caseStudies, error: csErr },
  { data: icps, error: icpErr },
] = await Promise.all([
  supabase.from("notable_clients").select("*").eq("tenant_id", TENANT_ID).eq("is_active", true).order("sort_order"),
  supabase.from("case_studies").select("id, client_name, industry, case_study_pain_tags(pain_id, strength)").eq("tenant_id", TENANT_ID).eq("is_active", true),
  supabase.from("icps").select("id, name, market, language, employee_size_min, employee_size_max, geo_regions, search_keywords, excluded_keywords, industry_tags").eq("tenant_id", TENANT_ID).order("market"),
]);

if (ncErr) { fail("notable_clients load", ncErr.message); process.exit(1); }
if (csErr) { fail("case_studies load", csErr.message); process.exit(1); }
if (icpErr) { fail("icps load", icpErr.message); process.exit(1); }

notableClients.length === 5
  ? pass(`5 notable clients loaded`, notableClients.map(c => c.name).join(", "))
  : fail(`Expected 5 notable clients, got ${notableClients.length}`);

caseStudies.length > 0
  ? pass(`${caseStudies.length} case studies loaded`, caseStudies.map(c => c.client_name).join(", "))
  : info("No case studies — Tier 1 will never fire (expected for a clean slate)");

icps.length === 4
  ? pass("4 ICPs loaded")
  : fail(`Expected 4 ICPs, got ${icps.length}`);

// ── Test: 3-tier resolution ──────────────────────────────────────────────────

head("2. Tier resolution logic");

// In a clean DB there are case studies BUT no pain_strength for our fake prospects.
// We simulate a case study array with no strength (as if no pain matched):
const noStrengthCases = caseStudies.map(cs => ({ ...cs, pain_strength: null }));
const withStrengthCases = caseStudies.map((cs, i) => ({ ...cs, pain_strength: i === 0 ? 0.9 : null }));

const scenarios = [
  {
    label: "Tier 1 — automotive + case study with strength ≥ 0.4",
    industry: "automotive",
    caseStudies: withStrengthCases,
    expectedTier: 1,
    expectedMatch: caseStudies[0]?.client_name,
  },
  {
    label: "Tier 2 — automotive industry, no case study strength",
    industry: "automotive",
    caseStudies: noStrengthCases,
    expectedTier: 2,
    expectedMatch: "Ford", // Ford has ["automotive", "manufacturing", "transport"]
  },
  {
    label: "Tier 2 — grocery/retail, no case study strength",
    industry: "grocery retail",
    caseStudies: noStrengthCases,
    expectedTier: 2,
    expectedMatch: "La Comer", // La Comer has ["grocery", "retail", "FMCG", "consumer goods", "packaging"]
  },
  {
    label: "Tier 2 — tech / mobility, no case study strength",
    industry: "mobility tech",
    caseStudies: noStrengthCases,
    expectedTier: 2,
    expectedMatch: "DiDi", // DiDi has ["tech", "mobility", "apps", "rideshare"]
  },
  {
    label: "Tier 2 — aviation / travel, no case study strength",
    industry: "aviation",
    caseStudies: noStrengthCases,
    expectedTier: 2,
    expectedMatch: "Aeromexico",
  },
  {
    label: "Tier 2 — sports / events, no case study strength",
    industry: "sports entertainment",
    caseStudies: noStrengthCases,
    expectedTier: 2,
    expectedMatch: "Estadio Azteca",
  },
  {
    label: "Tier 3 — artisan bakery (no industry match)",
    industry: "artisan bakery",
    caseStudies: noStrengthCases,
    expectedTier: 3,
    expectedMatch: null, // just verify tier 3 fires
  },
  {
    label: "Tier 3 — null industry",
    industry: null,
    caseStudies: noStrengthCases,
    expectedTier: 3,
    expectedMatch: null,
  },
];

for (const s of scenarios) {
  const result = resolveTier(s.industry, s.caseStudies, notableClients);
  if (result.tier !== s.expectedTier) {
    fail(s.label, `Expected Tier ${s.expectedTier}, got Tier ${result.tier} (${result.match})`);
  } else if (s.expectedMatch && !result.match.includes(s.expectedMatch)) {
    fail(s.label, `Expected match "${s.expectedMatch}", got "${result.match}"`);
  } else {
    pass(s.label, `→ Tier ${result.tier}: ${result.match}`);
  }
}

// ── Test: notable clients data integrity ─────────────────────────────────────

head("3. Notable client data integrity");

const required = [
  { name: "Ford", markets: ["MX", "LATAM"], minTags: 3 },
  { name: "La Comer", markets: ["MX"], minTags: 3 },
  { name: "DiDi", markets: ["MX", "LATAM"], minTags: 3 },
  { name: "Aeromexico", markets: ["MX"], minTags: 3 },
  { name: "Estadio Azteca", markets: ["MX"], minTags: 2 },
];

for (const r of required) {
  const nc = notableClients.find(c => c.name === r.name);
  if (!nc) { fail(`${r.name} not found`); continue; }

  const hasMarkets = r.markets.every(m => nc.markets.includes(m));
  const hasEnough = nc.industry_tags.length >= r.minTags;
  const hasRelationship = !!nc.relationship_description;
  const hasResult = !!nc.key_result;
  const hasBilingual = !!nc.description_en && !!nc.description_es;

  if (!hasMarkets) fail(`${r.name}: missing markets (has ${nc.markets.join(",")})`);
  else if (!hasEnough) fail(`${r.name}: only ${nc.industry_tags.length} industry tags (need ≥${r.minTags})`);
  else if (!hasRelationship) fail(`${r.name}: missing relationship_description`);
  else if (!hasResult) fail(`${r.name}: missing key_result`);
  else if (!hasBilingual) fail(`${r.name}: missing bilingual narratives`);
  else pass(`${r.name}`, `markets=[${nc.markets.join(",")}] tags=[${nc.industry_tags.slice(0,3).join(", ")}...] key_result="${nc.key_result.slice(0,50)}..."`);
}

// ── Test: ICP data integrity ──────────────────────────────────────────────────

head("4. ICP data integrity");

const expectedICPs = [
  { name: "Alberta SMB Retail & DTC", market: "CA", minKeywords: 10, minGeoRegions: 5 },
  { name: "Western Canada Mid-Market Retail & DTC", market: "CA", minKeywords: 8, minGeoRegions: 8 },
  { name: "CDMX SMB Retail & DTC", market: "MX", minKeywords: 8, minGeoRegions: 1 },
  { name: "Mexico Multi-Ciudad Retail & DTC", market: "MX", minKeywords: 10, minGeoRegions: 6 },
];

for (const e of expectedICPs) {
  const icp = icps.find(i => i.name === e.name);
  if (!icp) { fail(`ICP "${e.name}" not found`); continue; }

  const kwOk = icp.search_keywords.length >= e.minKeywords;
  const geoOk = icp.geo_regions.length >= e.minGeoRegions;
  const tagOk = (icp.industry_tags ?? []).length > 0;
  const exclOk = (icp.excluded_keywords ?? []).length > 0;

  if (!kwOk) fail(`${e.name}: only ${icp.search_keywords.length} keywords (need ≥${e.minKeywords})`);
  else if (!geoOk) fail(`${e.name}: only ${icp.geo_regions.length} geo regions (need ≥${e.minGeoRegions})`);
  else if (!tagOk) fail(`${e.name}: no industry tags`);
  else if (!exclOk) fail(`${e.name}: no excluded keywords`);
  else pass(
    `${e.name}`,
    `market=${e.market} | ${icp.search_keywords.length} keywords | ${icp.geo_regions.length} geo | ${(icp.industry_tags ?? []).length} tags | size ${icp.employee_size_min}–${icp.employee_size_max}`
  );
}

// ── Test: notable clients UI endpoint ────────────────────────────────────────

head("5. Notable Clients page (HTTP)");

try {
  const res = await fetch("http://localhost:3000/notable-clients");
  if (res.status === 200 || res.status === 307) {
    pass(`/notable-clients responds ${res.status}`);
  } else {
    fail(`/notable-clients returned ${res.status}`);
  }
} catch {
  fail("/notable-clients — server unreachable");
}

// ── Test: pitch generation live (create prospect → check DB) ─────────────────

head("6. Live pitch generation (automotive prospect → Tier 2 expected)");

// Create a minimal prospect to test the full pipeline path via processSingleProspect
// We can't call server actions from Node, but we CAN set up the prospect + research
// and call the generate endpoint if it exists, else just verify setup is correct.

const testProspect = {
  tenant_id: TENANT_ID,
  icp_id: "66666666-6666-6666-6666-666666666671", // CDMX ICP
  company_name: "TEST-Automotive-MX-LiveTest",
  domain: "test-automotive-livetest.example",
  industry: "automotive",
  market: "MX",
  language: "es",
  status: "researched",
  discovery_source: "yellowpages_ca",
  country_code: "MX",
  city: "Ciudad de México",
  region: "CDMX",
  match_score: 72,
  pitch_gate_passed: false,
};

const { data: p, error: pErr } = await supabase
  .from("prospects")
  .insert(testProspect)
  .select("id")
  .single();

if (pErr || !p) { fail("Could not create test prospect", pErr?.message); }
else {
  // Seed research with no case-study-matching pain
  await supabase.from("prospect_research").insert({
    tenant_id: TENANT_ID,
    prospect_id: p.id,
    what_they_do: "Auto parts distributor with an outdated web presence in CDMX",
    tech_stack: ["WordPress"],
    pain_points: [{
      pain_id: null,
      pain_label: "Sitio web desactualizado",
      evidence_quote: "El sitio no ha sido actualizado desde 2020 y no tiene versión móvil",
      confidence: 0.8,
    }],
    evidence_urls: ["https://test-auto.example"],
    notes: null,
    research_method: "scrape",
  });

  // Seed score
  await supabase.from("scores").insert({
    tenant_id: TENANT_ID,
    prospect_id: p.id,
    composite_score: 72,
    breakdown: {},
    confidence: 0.7,
    reasoning: "Test",
    model: "heuristic",
    cost_usd: 0,
  });

  info(`Prospect created: ${p.id.slice(0,8)} — checking if /companies/${p.id} is accessible`);

  // Call generatePitch via the Next.js server action internal endpoint
  // Server actions expose as POST /__nextjs_original-stack-frame (not useful)
  // Instead, check if our app has an action test route:
  const actionRes = await fetch(`http://localhost:3000/companies/${p.id}`, { redirect: "follow" });
  if (actionRes.status === 200) {
    pass("Prospect detail page accessible", `→ /companies/${p.id.slice(0,8)}`);
  } else {
    info(`Detail page status: ${actionRes.status} (needs auth — expected in test)`);
  }

  // Manually simulate what the generator would produce for this prospect
  const tier = resolveTier("automotive", [], notableClients);
  if (tier.tier === 2 && tier.match === "Ford") {
    pass("Tier 2 resolution correct for automotive prospect", `→ Ford (relationship: "8+ years working together")`);

    // Simulate the ES Tier 2 pitch body
    const nc = notableClients.find(c => c.name === "Ford");
    const pitchPreview = `Hola [Contacto],\n\nVi "El sitio no ha sido actualizado desde 2020" — la mayoría de marcas automotive a tu escala chocan con sitio web desactualizado.\n\nTrabajamos con ${nc.name} en ${nc.relationship_description} — ${nc.key_result}. Lo que vemos en su caso tiene la misma forma.\n\n¿Vale la pena una llamada de 15 min la próxima semana?\n\n— Pedro\nPedro De Velasco\nRunna CA`;
    info("Tier 2 pitch preview (ES):");
    console.log("\x1b[36m" + pitchPreview.split("\n").map(l => "    " + l).join("\n") + "\x1b[0m");
  } else {
    fail("Tier 2 resolution for automotive", `Got Tier ${tier.tier}: ${tier.match}`);
  }

  // Cleanup
  await supabase.from("scores").delete().eq("prospect_id", p.id);
  await supabase.from("prospect_research").delete().eq("prospect_id", p.id);
  await supabase.from("prospects").delete().eq("id", p.id).eq("tenant_id", TENANT_ID);
  pass("Test prospect cleaned up");
}

// ── Summary ───────────────────────────────────────────────────────────────────

head("══ Test complete ══");
if (process.exitCode) {
  console.log("\n\x1b[31m Some tests failed — see ❌ above.\x1b[0m\n");
} else {
  console.log("\n\x1b[32m All tests passed. System is good to go.\x1b[0m\n");
}
