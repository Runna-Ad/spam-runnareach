/**
 * Our own vocabulary for the exemplar allow-list (lib/pitches/exemplars.ts):
 * words our pitches use that are not among the 20,000 most frequent English or
 * Spanish words (./en.ts, ./es.ts). In the strict tier, so it holds words that
 * may stand capitalized mid-sentence. Keep it short and reviewed: every word
 * here can pass through an exemplar unchecked, so no person, business or place
 * names (those belong to prospects), only our name, our senders, the tools and
 * publishers we cite, and trade words. Found by scanning the pitch templates
 * and prompts in lib/pitches/ for words the frequency lists lack (2026-10-18),
 * and the publishers of the sourced benchmarks (migration 0037) without the
 * authors' surnames (Kim, Li, Zhang are prospects' surnames too).
 */
export const OWN_VOCABULARY: readonly string[] = [
  // Us and our senders.
  "runna", "nils",
  // Cold-email and marketing words.
  "cta", "ctas", "url", "urls", "seo", "sem", "ppc", "cpc", "cpa", "roi", "roas", "ltv", "crm", "cms", "ux", "ui", "kpi",
  "kpis", "ota", "otas", "dtc", "ecommerce", "signup", "signups", "checkout", "inbox", "workflow", "workflows", "triage",
  "dropshipping", "retargeting", "chatbot", "chatbots", "benchmark", "benchmarks", "metric", "metrics", "keyword",
  "keywords", "wellness", "automotive", "apparel", "consultancy", "advisory", "realty", "functionality", "measurable",
  "online", "offline", "app", "apps", "website", "websites", "webpage", "landing", "homepage", "pagespeed", "mobile",
  "followup", "unbooked", "recaptured", "abandonment", "redesign", "redesigning", "optimize", "optimization",
  "segmentation", "attribution", "recapture", "handoff", "inconsistent", "shoppers", "enquiry", "enquiries", "upsell",
  "rebooking", "walkins", "voicemail", "voicemails", "intake", "noshow", "noshows", "unanswered", "nurture", "chatbot",
  // Spanish trade words.
  "agendar", "agende", "agendan", "agenda", "automatizar", "automatizacion", "optimizar", "optimizacion", "prospectos",
  "consultoria", "notaria", "taqueria", "hosteria", "hospedaje", "vacacional", "automotriz", "empaque", "nutricion",
  "fisio", "fisioterapia", "concesionario", "palapa", "anaquel", "redisenar", "intencional", "diagnosticar", "medible",
  "medibles", "dispersa", "disperso", "platicar", "platiquemos", "platica", "agendado", "agendada", "agendadas",
  "agendados", "cotizacion", "cotizaciones", "cotizar", "whatsapps",
  // Tools, platforms and the publishers our benchmarks cite.
  "google", "gmail", "whatsapp", "instagram", "facebook", "linkedin", "tiktok", "youtube", "shopify", "woocommerce",
  "tiendanube", "wordpress", "wix", "squarespace", "hubspot", "baymard", "statista", "wordstream", "brightlocal",
  "semrush", "ahrefs", "moz", "lighthouse", "gtmetrix", "yelp", "tripadvisor", "booking", "airbnb", "opentable",
  "calendly", "stripe", "paypal", "mercadolibre", "mercadopago", "expedia", "rappi", "ubereats", "didi",
  // Publishers in 0037 (and the hotel benchmark source HVS).
  "bmj", "bain", "brightlocal", "clio", "cloudbeds", "cochrane", "deloitte", "drift", "experian", "forrester", "gartner",
  "harvard", "hbr", "ipsos", "klaviyo", "litmus", "mckinsey", "datamatics", "nber", "nucleus", "omnisend",
  "phocuswright", "phocuswire", "portent", "salesforce", "smartsheet", "spiegel", "northwestern", "sprout", "stanford",
  "persuasive", "toast", "wyzowl", "wharton", "mit", "hvs", "systematic", "meta", "analysis", "pulse",
  // The one place our own templates name (beach clubs); a prospect's own city is still caught by the field check.
  "cancun",
];

/**
 * Names that are also everyday words ("vale la pena", "agua de rosa", "miss the
 * mark", "a grant"). Not in the strict tier, so a capitalized one mid-sentence
 * or in a subject drops the exemplar ("we spoke with Rosa"); allowed in the
 * generous tier (lower case, or opening a sentence). Only words used mostly as
 * names: subjects are all strict, so "page", "price" or "will" stay out, and
 * months too ("in May" is a date). The current prospect's own name is caught by the
 * field check whatever its case.
 */
export const WORD_NAMES: readonly string[] = [
  "pena", "rosa", "dolores", "amparo", "consuelo", "rocio", "pilar", "mercedes", "guadalupe", "soledad", "rosario",
  "esperanza", "blanca", "clara", "dulce", "luz", "paz", "cruz", "flores", "torres", "leal", "mark", "grant", "frank",
  "grace", "dean", "bill", "rose", "victoria", "lee", "earnest", "ernest", "holly", "daisy", "ruby", "ivy", "iris",
  "jasmine", "violeta", "jazmin",
];

/**
 * Common given names and surnames in Canada, Mexico and the US that are in the
 * frequency lists (film subtitles are full of names) but are not everyday
 * words. Removed from the allow-list, so an exemplar that still names anyone
 * this common is dropped. Names that ARE words (White, Green, Hill, Young,
 * Rose, Flores, Torres, Cruz, Park) are left to the field check, and our own
 * senders (Henry, Nils, Pedro) are not here.
 */
export const COMMON_NAMES: readonly string[] = [
  // Surnames, Spanish.
  "garcia", "martinez", "lopez", "gonzalez", "rodriguez", "hernandez", "perez", "sanchez", "ramirez", "gomez", "diaz",
  "ortiz", "chavez", "ruiz", "mendoza", "castillo", "vargas", "romero", "herrera", "medina", "reyes", "jimenez",
  "gutierrez", "aguilar", "alvarez", "fernandez", "morales", "rivera", "moreno", "castro", "ramos", "vazquez",
  "dominguez", "nunez", "salazar", "estrada", "guzman", "rojas", "navarro", "delgado", "soto", "contreras",
  "sandoval", "guerrero", "rios", "mejia", "cervantes", "ibarra", "velazquez", "zamora", "cardenas", "espinoza",
  // Surnames, English, French-Canadian, other.
  "smith", "johnson", "williams", "jones", "miller", "davis", "wilson", "anderson", "taylor", "thomas", "moore",
  "jackson", "thompson", "harris", "clark", "lewis", "robinson", "walker", "allen", "wright", "scott", "adams",
  "nelson", "carter", "mitchell", "roberts", "turner", "phillips", "campbell", "parker", "evans", "edwards", "collins",
  "stewart", "morris", "murphy", "rogers", "morgan", "peterson", "reed", "bailey", "kelly", "howard", "richardson",
  "watson", "bennett", "hughes", "sanders", "myers", "ross", "macdonald", "mackenzie", "fraser", "sullivan",
  "patel", "singh", "chen", "wang", "zhang", "liu", "wong", "nguyen", "tran", "kim", "choi", "khan", "ahmed",
  "hussain", "shah", "tremblay", "gagnon", "bouchard", "gauthier", "morin", "lavoie", "fortin", "gagne", "ouellet",
  "pelletier", "belanger", "levesque", "bergeron", "leblanc", "girard", "simard", "boucher", "caron", "beaulieu",
  "cloutier", "poirier", "fournier", "lapointe", "leclerc", "lefebvre", "wagner", "schmidt", "muller", "kowalski",
  "nowak", "nakamura", "tanaka", "suzuki", "yamamoto", "ivanov", "rossi", "russo", "garza", "mcdonald", "rao", "reddy",
  "kapoor",
  // Given names.
  "maria", "jose", "juan", "luis", "carlos", "jorge", "miguel", "francisco", "antonio", "alejandro", "fernando",
  "ricardo", "roberto", "eduardo", "javier", "rafael", "sergio", "raul", "manuel", "ana", "laura", "sofia",
  "gabriela", "mariana", "daniela", "fernanda", "valeria", "alejandra", "andrea", "patricia", "john", "robert",
  "michael", "william", "david", "richard", "joseph", "charles", "christopher", "matthew", "anthony", "steven",
  "andrew", "joshua", "kevin", "brian", "jason", "ryan", "jennifer", "linda", "elizabeth", "barbara", "susan",
  "jessica", "sarah", "karen", "nancy", "lisa", "sandra", "ashley", "emily", "michelle", "amanda", "melissa",
  "stephanie", "rebecca", "priya", "raj", "mohammed", "muhammad", "sean", "siobhan", "bjorn", "lukasz", "jean",
  "pierre", "marie", "francois", "luc", "isabelle", "sylvie", "nathalie", "chantal", "guillaume", "mathieu",
];
