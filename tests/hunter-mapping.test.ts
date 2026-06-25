import assert from "node:assert/strict";
import test from "node:test";
import {
  mapToHunterIndustry,
  mapToHunterSize,
  painToTimesink,
  painToLeadKey,
  buildHunterUrl,
  buildHunterUrlForPitch,
  HUNTER_LEAD_SLUGS,
} from "../lib/pitches/hunter-mapping.ts";

test("mapToHunterIndustry: free-text industry → Hunter enum", () => {
  assert.equal(mapToHunterIndustry("DTC coffee brand"), "ecommerce");
  assert.equal(mapToHunterIndustry("corporate law firm"), "proservices");
  assert.equal(mapToHunterIndustry("boutique hotel in Tulum"), "hospitality");
  assert.equal(mapToHunterIndustry("car dealership"), "automotive");
  assert.equal(mapToHunterIndustry("dental clinic"), "fitness"); // health → fitness bucket
  assert.equal(mapToHunterIndustry("real estate brokerage"), "realestate");
  assert.equal(mapToHunterIndustry(null), "other");
  assert.equal(mapToHunterIndustry("underwater basket weaving"), "other");
});

test("mapToHunterSize: headcount → bucket, omit when unknown", () => {
  assert.equal(mapToHunterSize(null), null);
  assert.equal(mapToHunterSize(0), null);
  assert.equal(mapToHunterSize(1), "solo");
  assert.equal(mapToHunterSize(8), "small");
  assert.equal(mapToHunterSize(40), "mid");
  assert.equal(mapToHunterSize(500), "large");
});

test("painToTimesink: classifies representative pain labels", () => {
  assert.equal(painToTimesink("Cart abandonment on mobile"), "email");
  assert.equal(painToTimesink("Manual sales / lead process"), "leads");
  assert.equal(painToTimesink("Low ROAS on paid media"), "ads");
  assert.equal(painToTimesink("Inconsistent social content"), "social");
  assert.equal(painToTimesink("Outdated brand and packaging"), "production");
  assert.equal(painToTimesink("Manual reporting eats hours"), "reporting");
  assert.equal(painToTimesink(null), null);
  assert.equal(painToTimesink("something with no keyword"), null);
});

test("painToLeadKey: returns a slug valid for the chosen industry, else null", () => {
  // Law-firm AI/automation pain → ai-automation (exists in every pool)
  assert.equal(painToLeadKey("Manual intake — automate it", "proservices"), "ai-automation");
  // Email pain → proservices has no 'email-automation' but does have referral-program
  assert.equal(painToLeadKey("Cart abandonment", "ecommerce"), "email-automation");
  // Ads pain in automotive → buyer-profile-ads is the valid ads slug there
  assert.equal(painToLeadKey("Wasted ad spend", "automotive"), "buyer-profile-ads");
  // Reporting pain in retail → attribution-dashboard
  assert.equal(painToLeadKey("Manual reporting", "retail"), "attribution-dashboard");
  // Website/outdated pain → website-modern (special injected slug, any industry)
  assert.equal(painToLeadKey("Outdated, non-responsive website", "proservices"), "website-modern");
  assert.equal(painToLeadKey("needs a redesign", "restaurant"), "website-modern");
  assert.equal(painToTimesink("Outdated website"), "production");
  // Unclassifiable pain → null
  assert.equal(painToLeadKey("xyzzy", "ecommerce"), null);
  // Every returned slug must exist in the industry's pool
  for (const ind of Object.keys(HUNTER_LEAD_SLUGS) as (keyof typeof HUNTER_LEAD_SLUGS)[]) {
    const slug = painToLeadKey("AI automation opportunity", ind);
    assert.ok(slug && HUNTER_LEAD_SLUGS[ind].includes(slug), `ai-automation valid for ${ind}`);
  }
});

test("buildHunterUrl: keeps market, appends only non-empty params + v=1", () => {
  const url = buildHunterUrl({
    market: "ca",
    industry: "proservices",
    size: "small",
    timesink: "leads",
    tools: ["LinkedIn", "Calendly"],
    website: "example.com",
    lead: "ai-automation",
  });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://runna-hunter.vercel.app/");
  assert.equal(u.searchParams.get("market"), "ca");
  assert.equal(u.searchParams.get("industry"), "proservices");
  assert.equal(u.searchParams.get("size"), "small");
  assert.equal(u.searchParams.get("timesink"), "leads");
  assert.equal(u.searchParams.get("tools"), "LinkedIn,Calendly");
  assert.equal(u.searchParams.get("website"), "example.com");
  assert.equal(u.searchParams.get("lead"), "ai-automation");
  assert.equal(u.searchParams.get("v"), "1");
});

test("buildHunterUrl: omits empty/null params", () => {
  const u = new URL(buildHunterUrl({ market: "mx", tools: [], website: "  " }));
  assert.equal(u.searchParams.get("market"), "mx");
  assert.equal(u.searchParams.has("industry"), false);
  assert.equal(u.searchParams.has("tools"), false);
  assert.equal(u.searchParams.has("website"), false);
  assert.equal(u.searchParams.get("v"), "1");
});

test("buildHunterUrlForPitch: end-to-end law-firm scenario pins the AI chatbot", () => {
  const url = buildHunterUrlForPitch({
    language: "es",
    market: "mx",
    industry: "despacho de abogados",
    employeeEstimate: 8,
    painLabel: "Manual lead intake — needs automation",
    techStack: ["WhatsApp Business", "Gmail"],
    domain: "saucedoa.com",
    websiteUrl: null,
  });
  const u = new URL(url);
  assert.equal(u.searchParams.get("market"), "mx");
  assert.equal(u.searchParams.get("industry"), "proservices");
  assert.equal(u.searchParams.get("size"), "small");
  assert.equal(u.searchParams.get("timesink"), "leads");
  assert.equal(u.searchParams.get("lead"), "ai-automation");
  assert.equal(u.searchParams.get("website"), "saucedoa.com");
});

test("buildHunterUrlForPitch: market derives from language when not ca/mx", () => {
  const u = new URL(
    buildHunterUrlForPitch({
      language: "en",
      market: null,
      industry: "online store",
      employeeEstimate: null,
      painLabel: null,
      techStack: null,
      domain: null,
      websiteUrl: "https://shop.example.com/path",
    }),
  );
  assert.equal(u.searchParams.get("market"), "ca");
  assert.equal(u.searchParams.get("industry"), "ecommerce");
  assert.equal(u.searchParams.has("size"), false); // unknown headcount omitted
  assert.equal(u.searchParams.get("website"), "shop.example.com");
});
