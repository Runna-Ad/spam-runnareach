// E2E verifier for lead crawling — Yellow Pages CA + Brave Search.
// Logs in, goes to /discover, runs a YP crawl for "pet food" / Alberta,
// then runs a Brave crawl for '"pet food" shopify canada'.
// Reads back new prospect rows from Supabase to confirm inserts worked.
//
// Usage:
//   PORT=3001 TEST_EMAIL=petedv31@gmail.com TEST_PASSWORD=RunnaCase2026! \
//     node scripts/screenshot-crawl.mjs

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const env = readFileSync(".env.local", "utf8")
  .split("\n")
  .reduce((a, l) => {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) a[m[1]] = m[2];
    return a;
  }, {});

const PORT = process.env.PORT ?? "3001";
const BASE = `http://localhost:${PORT}`;
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
const TENANT = "11111111-1111-1111-1111-111111111111";

const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
);

// Count prospects before so we can compare after
const before = await admin
  .from("prospects")
  .select("id", { count: "exact", head: true })
  .eq("tenant_id", TENANT);
console.log("prospects before:", before.count);

const browser = await chromium.launch({ headless: false, slowMo: 100 });
const page = await (
  await browser.newContext({ viewport: { width: 1440, height: 900 } })
).newPage();
page.on("pageerror", (e) => console.error("PAGEERR", e.message));

// ── Login ──────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/sign-in`);
await page.fill('input[name="email"]', TEST_EMAIL);
await page.fill('input[name="password"]', TEST_PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 60_000 });
console.log("✓ logged in");

// ── Navigate to /discover ──────────────────────────────────────────────────
await page.goto(`${BASE}/discover`);
await page.waitForLoadState("networkidle");
await page.screenshot({ path: "/tmp/spam-crawl-discover.png" });
console.log("✓ /tmp/spam-crawl-discover.png — /discover page");

// ── Yellow Pages CA crawl ─────────────────────────────────────────────────
console.log("\n→ opening YP crawl drawer...");
// Click "Run discovery" on Yellow Pages CA card
const ypBtn = page.getByRole("button", { name: /run discovery/i }).first();
await ypBtn.click();
await page.waitForSelector("#crawl-keyword", { timeout: 5_000 });

await page.fill("#crawl-keyword", "pet food");
// Province is already "All Canada" — leave it or pick Alberta
await page.selectOption("#crawl-location", "Alberta");
await page.selectOption("#crawl-pages", "1");

console.log("→ submitting YP crawl...");
const t0 = Date.now();
await page.getByRole("button", { name: /^Run crawl$/i }).click();

// Wait for success message
await page.waitForSelector("text=/new prospect|error/i", { timeout: 60_000 });
console.log(`→ YP crawl done in ${Date.now() - t0}ms`);

await page.screenshot({ path: "/tmp/spam-crawl-yp-result.png" });
console.log("✓ /tmp/spam-crawl-yp-result.png");

// ── Close YP drawer ───────────────────────────────────────────────────────
await page.getByRole("button", { name: /^Close$/i }).first().click();
await page.waitForTimeout(400);

// ── Brave Search crawl ────────────────────────────────────────────────────
console.log("\n→ opening Brave crawl drawer...");
// Brave is the second "Run discovery" button
const braveBtn = page.getByRole("button", { name: /run discovery/i }).nth(1);
await braveBtn.click();
await page.waitForSelector("#crawl-keyword", { timeout: 5_000 });

await page.fill("#crawl-keyword", '"pet food" shopify canada');
console.log("→ submitting Brave crawl...");
const t1 = Date.now();
await page.getByRole("button", { name: /^Run crawl$/i }).click();
await page.waitForSelector("text=/new prospect|error/i", { timeout: 60_000 });
console.log(`→ Brave crawl done in ${Date.now() - t1}ms`);

await page.screenshot({ path: "/tmp/spam-crawl-brave-result.png" });
console.log("✓ /tmp/spam-crawl-brave-result.png");

await browser.close();

// ── Verify inserts ─────────────────────────────────────────────────────────
const after = await admin
  .from("prospects")
  .select("id", { count: "exact", head: true })
  .eq("tenant_id", TENANT);
console.log("\nprospects after:", after.count, `(+${(after.count ?? 0) - (before.count ?? 0)} new)`);

const { data: runs } = await admin
  .from("discovery_runs")
  .select("source, status, candidates_found, candidates_new, candidates_duplicate, error_message")
  .eq("tenant_id", TENANT)
  .in("source", ["yellowpages_ca", "brave_search"])
  .order("created_at", { ascending: false })
  .limit(2);
console.log("\n=== Latest discovery runs ===");
console.log(runs);

const { data: newProspects } = await admin
  .from("prospects")
  .select("company_name, domain, discovery_source, city, region")
  .eq("tenant_id", TENANT)
  .in("discovery_source", ["yellowpages_ca", "brave_search"])
  .order("created_at", { ascending: false })
  .limit(10);
console.log("\n=== New prospects (latest 10) ===");
newProspects?.forEach((p) =>
  console.log(` [${p.discovery_source}] ${p.company_name} | ${p.domain ?? "—"} | ${p.city ?? "?"}, ${p.region ?? "?"}`)
);
