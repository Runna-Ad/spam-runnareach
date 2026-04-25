// Quick smoke for the site scraper. Hits 2 known sites and prints what
// we extract — used to verify fingerprint coverage during development.

import { scrapeSite } from "../lib/research/scraper";

async function main() {
  const targets = ["https://shopify.com", "https://runna.agency"];
  for (const url of targets) {
    console.log("\n=================");
    console.log("Scraping:", url);
    console.log("=================");
    const start = Date.now();
    const result = await scrapeSite(url);
    console.log("Took:", `${Date.now() - start}ms`);
    if (!result.ok) {
      console.log("FAILED:", result.error);
      continue;
    }
    const s = result.site;
    console.log("Final URL:", s.final_url);
    console.log("HTTP:", s.http_status);
    console.log("what_they_do:", s.what_they_do?.slice(0, 200) ?? "(none)");
    console.log("tech_stack:", s.tech_stack);
    console.log("emails:", s.contact_emails);
    console.log("socials:", s.social_links);
    console.log("key pages:", s.key_pages);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
