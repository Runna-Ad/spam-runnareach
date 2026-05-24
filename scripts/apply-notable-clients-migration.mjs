/**
 * One-time script to apply the notable_clients migration and seed data.
 * Run: node scripts/apply-notable-clients-migration.mjs
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf-8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const idx = l.indexOf("=");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
);

const SUPABASE_URL = env["NEXT_PUBLIC_SUPABASE_URL"];
const SERVICE_KEY = env["SUPABASE_SERVICE_ROLE_KEY"];
const TENANT_ID = "11111111-1111-1111-1111-111111111111";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// Try seeding — if table doesn't exist this will fail with a clear message
const clients = [
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    tenant_id: TENANT_ID,
    name: "Ford",
    industry_tags: ["automotive", "manufacturing", "transport"],
    markets: ["MX", "LATAM"],
    relationship_description: "8+ years working together",
    services_provided: ["social media", "production", "brand campaigns"],
    key_result: "Large-scale brand and production campaigns across multiple verticals",
    description_en:
      "Over 8+ years we've built and scaled Ford's brand campaigns and production across Mexico and LATAM — spanning automotive launches, digital content, and live event production.",
    description_es:
      "Durante más de 8 años hemos construido y escalado las campañas de marca y producción de Ford en México y LATAM — desde lanzamientos automotrices hasta contenido digital y producción de eventos.",
    sort_order: 1,
  },
  {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    tenant_id: TENANT_ID,
    name: "La Comer",
    industry_tags: ["grocery", "retail", "FMCG", "consumer goods", "packaging"],
    markets: ["MX"],
    relationship_description: "10+ years, 400+ product packages designed",
    services_provided: ["packaging design", "brand identity", "private label"],
    key_result: "400+ packaging designs across food, cleaning, and consumer goods categories",
    description_en:
      "10+ year partnership designing over 400 product packages across La Comer's private label categories — food, cleaning supplies, and consumer goods.",
    description_es:
      "Más de 10 años diseñando más de 400 empaques de producto para las categorías de marca propia de La Comer — alimentos, limpieza y consumibles.",
    sort_order: 2,
  },
  {
    id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    tenant_id: TENANT_ID,
    name: "DiDi",
    industry_tags: ["tech", "mobility", "apps", "rideshare"],
    markets: ["MX", "LATAM"],
    relationship_description:
      "5+ years — grew from 1 department to full company across 9 LATAM countries",
    services_provided: ["social media", "content production", "creative strategy"],
    key_result: "Social media and production scaled to 9 LATAM markets",
    description_en:
      "Started with DiDi's Mexico City social team and scaled the entire creative operation across 9 LATAM countries — strategy, production, and community management.",
    description_es:
      "Comenzamos con el equipo de redes sociales de DiDi en CDMX y escalamos toda la operación creativa a 9 países de LATAM — estrategia, producción y gestión de comunidad.",
    sort_order: 3,
  },
  {
    id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    tenant_id: TENANT_ID,
    name: "Aeromexico",
    industry_tags: ["aviation", "travel", "tourism", "hospitality"],
    markets: ["MX"],
    relationship_description: "Versatile, impact-driven campaigns",
    services_provided: ["app creation", "VR experiences", "campaign production"],
    key_result: "App creation, VR experiences, out-of-the-box campaigns",
    description_en:
      "Produced Aeromexico's most innovative campaigns — from VR travel experiences to mobile app activations and live event productions.",
    description_es:
      "Producimos las campañas más innovadoras de Aeromexico — desde experiencias de viaje en VR hasta activaciones de app móvil y producciones de eventos en vivo.",
    sort_order: 4,
  },
  {
    id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
    tenant_id: TENANT_ID,
    name: "Estadio Azteca",
    industry_tags: ["sports", "entertainment", "venues", "events"],
    markets: ["MX"],
    relationship_description: "Social media and fan experience strategy",
    services_provided: ["social media", "content strategy", "event experience"],
    key_result: "40% revenue increase on stadium tours",
    description_en:
      "Redesigned Estadio Azteca's social media strategy and fan experience journey — resulting in a 40% revenue increase on stadium tours.",
    description_es:
      "Rediseñamos la estrategia de redes sociales y la experiencia del aficionado del Estadio Azteca — logrando un aumento del 40% en los ingresos de los tours del estadio.",
    sort_order: 5,
  },
];

const { data, error } = await supabase
  .from("notable_clients")
  .upsert(clients, { onConflict: "id" })
  .select("id, name");

if (error) {
  if (error.message.includes("does not exist") || error.code === "42P01") {
    console.error(
      `\n❌ Table 'notable_clients' does not exist yet.\n\n` +
        `Please apply the migration first:\n` +
        `  1. Open Supabase dashboard → SQL Editor\n` +
        `  2. Copy-paste supabase/migrations/0009_notable_clients.sql\n` +
        `  3. Run it\n` +
        `  4. Then re-run this script\n`,
    );
  } else {
    console.error("❌ Seed failed:", error.message);
  }
  process.exit(1);
}

console.log(`\n✅ Seeded ${data?.length ?? 0} notable clients:`);
data?.forEach((c) => console.log(`   - ${c.name} (${c.id})`));
