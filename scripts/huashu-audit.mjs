import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const pages = [
  { path: "/dashboard", name: "dashboard" },
  { path: "/companies", name: "companies" },
  { path: "/pitches", name: "pitches" },
  { path: "/icp", name: "icp" },
  { path: "/case-studies", name: "casestudies" },
  { path: "/learning", name: "learning" },
  { path: "/discover", name: "discover" },
  { path: "/funnel", name: "funnel" },
];

const BASE = "https://spam-runnareach.vercel.app";

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Sign in
  await page.goto(`${BASE}/sign-in`);
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/dashboard`, { timeout: 15000 });
  console.log("✓ Authenticated");

  for (const p of pages) {
    await page.goto(`${BASE}${p.path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const out = `/tmp/spam-huashu-${p.name}.png`;
    await page.screenshot({ path: out, fullPage: false });
    console.log(`✓ ${p.name} → ${out}`);
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
