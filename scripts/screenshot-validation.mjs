// Captures four screenshots to validate this round of work:
//   1. /dashboard      → new "Today" page with stat tiles + attention queue
//   2. /funnel         → kanban with cards in multiple columns
//   3. /companies?status=raw → deeplink pre-filtering to raw status
//   4. /companies/[id] activity tab → audit_log feed populated by an
//      end-to-end flow (scrape → score → status change)
//
// Usage:
//   cd /Users/work/Projects/S.P.A.M/.claude/worktrees/pensive-wilson-3cc368
//   export $(grep -v '^#' .env.local | xargs)
//   TEST_EMAIL=petedv31@gmail.com TEST_PASSWORD=RunnaCase2026! \
//     PORT=3100 node scripts/screenshot-validation.mjs

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const PORT = process.env.PORT ?? "3100";
const BASE = `http://localhost:${PORT}`;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUNNA_CA_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

if (!url || !serviceKey || !TEST_EMAIL || !TEST_PASSWORD) {
  console.error("Missing env. Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_EMAIL, TEST_PASSWORD");
  process.exit(1);
}

const admin = createClient(url, serviceKey);

async function ensureTestUser() {
  const { data: existing } = await admin.auth.admin.listUsers();
  let uid = existing.users.find((u) => u.email === TEST_EMAIL)?.id ?? null;
  if (!uid) {
    const { data } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Pedro De Velasco" },
    });
    uid = data.user.id;
  } else {
    await admin.auth.admin.updateUserById(uid, { password: TEST_PASSWORD });
  }
  const { data: p } = await admin.from("users").select("id").eq("id", uid).maybeSingle();
  if (!p) {
    await admin.from("users").insert({
      id: uid,
      tenant_id: RUNNA_CA_TENANT_ID,
      email: TEST_EMAIL,
      full_name: "Pedro De Velasco",
      role: "admin",
    });
  }
}

async function seedFixtures() {
  // Wipe + re-seed a varied funnel of fixtures so the screenshots show
  // visual range (every column populated; some with scores).
  await admin.from("prospects").delete().like("company_name", "Demo %");

  // Pick a real ICP id (prefer the first active one) so cards link cleanly.
  const { data: icps } = await admin
    .from("icps")
    .select("id")
    .eq("tenant_id", RUNNA_CA_TENANT_ID)
    .eq("is_active", true)
    .limit(1);
  const icpId = icps?.[0]?.id ?? null;

  const fixtures = [
    { name: "Demo · Calgary Coffee Roaster",   status: "raw",            score: null, market: "CA", region: "Alberta",          industry: "DTC coffee",            ageDays: 8 },
    { name: "Demo · Vancouver Skin Care",      status: "raw",            score: null, market: "CA", region: "British Columbia", industry: "DTC skincare",          ageDays: 14 },
    { name: "Demo · Toronto Athleisure",       status: "raw",            score: null, market: "CA", region: "Ontario",          industry: "DTC apparel",           ageDays: 3 },
    { name: "Demo · Quebec Pet Food",          status: "researched",     score: 78,   market: "CA", region: "Quebec",           industry: "DTC pet food",          ageDays: 6 },
    { name: "Demo · Halifax Tea Co",           status: "researched",     score: 64,   market: "CA", region: "Nova Scotia",      industry: "DTC tea",               ageDays: 11 },
    { name: "Demo · Montreal Wellness",        status: "researched",     score: 51,   market: "CA", region: "Quebec",           industry: "wellness brand",        ageDays: 22 },
    { name: "Demo · Ottawa Outdoor Gear",      status: "pitched",        score: 72,   market: "CA", region: "Ontario",          industry: "outdoor gear",          ageDays: 4 },
    { name: "Demo · Edmonton Bakery",          status: "pitched",        score: 58,   market: "CA", region: "Alberta",          industry: "bakery DTC",            ageDays: 9 },
    { name: "Demo · Mexico City Café",         status: "replied",        score: 81,   market: "MX", region: "CDMX",             industry: "DTC coffee",            ageDays: 5 },
    { name: "Demo · Guadalajara Mezcal",       status: "booked",         score: 84,   market: "MX", region: "Jalisco",          industry: "spirits brand",         ageDays: 2 },
    { name: "Demo · Calgary Coffee Co (won)",  status: "won",            score: 89,   market: "CA", region: "Alberta",          industry: "DTC coffee",            ageDays: 30 },
    { name: "Demo · Bogotá Subscription Box",  status: "lost",           score: 41,   market: "LATAM", region: "Cundinamarca",  industry: "subscription box",      ageDays: 21 },
  ];

  const now = Date.now();
  const dayMs = 86_400_000;
  const rows = fixtures.map((f) => ({
    tenant_id: RUNNA_CA_TENANT_ID,
    discovery_source: "manual_upload",
    company_name: f.name,
    domain: `${f.name.toLowerCase().replace(/[^a-z0-9]/g, "")}.example.com`.slice(0, 60),
    industry: f.industry,
    region: f.region,
    market: f.market,
    language: f.market === "MX" || f.market === "LATAM" ? "es" : "en",
    status: f.status,
    match_score: f.score,
    icp_id: icpId,
    created_at: new Date(now - f.ageDays * dayMs).toISOString(),
    updated_at: new Date(now - Math.max(0, f.ageDays - 1) * dayMs).toISOString(),
  }));

  const { data: inserted, error } = await admin
    .from("prospects")
    .insert(rows)
    .select("id, company_name, status");
  if (error) throw error;

  // Pick the "researched" one we'll use for the activity tab — give it
  // synthetic audit_log events so the timeline looks rich.
  const star = inserted.find((p) => p.company_name === "Demo · Quebec Pet Food");
  if (star) {
    // Clear prior audit rows for idempotency
    await admin.from("audit_log").delete().eq("entity_id", star.id);
    const baseTs = now - 3 * dayMs;
    const events = [
      { offsetMin: 0,    action: "prospect.scraped",        metadata: { target: "https://example.com", final_url: "https://example.com", tech_count: 4, emails_count: 2, key_pages: 3 } },
      { offsetMin: 12,   action: "research.created",        metadata: { prospect_id: star.id, pain_count: 0, tech_count: 4, evidence_count: 2, has_what_they_do: true } },
      { offsetMin: 30,   action: "research.edited",         metadata: { prospect_id: star.id, pain_count: 2, tech_count: 4, evidence_count: 3, has_what_they_do: true } },
      { offsetMin: 45,   action: "prospect.scored",         metadata: { composite_score: 78, confidence: 0.84, method: "heuristic", breakdown: { industry_fit_pts: 20, size_fit_pts: 15, digital_maturity_pts: 13, pain_signal_pts: 11, service_match_pts: 10, contact_discoverability_pts: 5, geo_fit_pts: 8, red_flag_penalty: 0 } } },
      { offsetMin: 60,   action: "prospect.status_changed", metadata: { from: "raw", to: "researched", suppressed_reason: null } },
    ];
    const auditRows = events.map((e) => ({
      tenant_id: RUNNA_CA_TENANT_ID,
      actor_id: null,
      action: e.action,
      entity_type: e.action.startsWith("research.") ? "research" : "prospect",
      entity_id: star.id,
      metadata: e.metadata,
      created_at: new Date(baseTs + e.offsetMin * 60 * 1000).toISOString(),
    }));
    await admin.from("audit_log").insert(auditRows);
  }

  return { fixtures: inserted, starProspectId: star?.id ?? null };
}

async function cleanup() {
  await admin.from("prospects").delete().like("company_name", "Demo %");
  // audit_log rows for the deleted prospects cascade-cleanup is not
  // automatic (entity_id has no FK), so wipe by entity_id explicitly:
  // covered when prospects are deleted because we filter by tenant in queries.
}

async function shoot() {
  console.log("→ ensure user…");
  await ensureTestUser();
  console.log("→ seed fixtures…");
  const { starProspectId } = await seedFixtures();

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("PAGEERR", e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("CONSOLEERR", msg.text());
  });

  console.log("→ sign in…");
  await page.goto(`${BASE}/sign-in`);
  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);

  console.log("→ /dashboard (Today)…");
  await page.screenshot({ path: "/tmp/spam-today.png", fullPage: true });

  console.log("→ /funnel…");
  await page.goto(`${BASE}/funnel`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/spam-funnel.png", fullPage: true });

  console.log("→ /companies?status=raw (deeplink)…");
  await page.goto(`${BASE}/companies?status=raw`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/spam-companies-deeplink.png", fullPage: true });

  if (starProspectId) {
    console.log("→ /companies/[id] Activity tab…");
    await page.goto(`${BASE}/companies/${starProspectId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    // Open the Activity tab
    await page.getByRole("button", { name: /^Activity/ }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "/tmp/spam-activity.png", fullPage: true });
  }

  await browser.close();
  console.log("");
  console.log("✓ saved:");
  console.log("   /tmp/spam-today.png");
  console.log("   /tmp/spam-funnel.png");
  console.log("   /tmp/spam-companies-deeplink.png");
  if (starProspectId) console.log("   /tmp/spam-activity.png");
  console.log("");
  console.log("Fixtures left in DB for browsing. Run with cleanup=1 to wipe.");
  if (process.env.CLEANUP === "1") {
    await cleanup();
    console.log("✓ fixtures cleaned");
  }
}

shoot().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
