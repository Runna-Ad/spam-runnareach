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
 * Names made only of words on these lists ("Blue Sky Dental") are no leak here:
 * only the exemplar's own field checks protect them.
 */
export const OWN_VOCABULARY: readonly string[] = [
  // Us and our senders (the default sender names, lib/pitches/sender-identity.ts).
  "runna", "nils", "henry",
  // Cold-email and marketing words (acronyms are in OWN_ACRONYMS).
  "ecommerce", "signup", "signups", "checkout", "inbox", "workflow", "workflows", "triage",
  "dropshipping", "retargeting", "chatbot", "chatbots", "benchmark", "benchmarks", "metric", "metrics", "keyword",
  "keywords", "wellness", "automotive", "apparel", "consultancy", "advisory", "realty", "functionality", "measurable",
  "online", "offline", "app", "apps", "website", "websites", "webpage", "landing", "homepage", "pagespeed", "mobile",
  "followup", "unbooked", "recaptured", "abandonment", "redesign", "redesigning", "optimize", "optimization",
  "segmentation", "attribution", "recapture", "handoff", "inconsistent", "shoppers", "enquiry", "enquiries", "upsell",
  "rebooking", "walkins", "voicemail", "voicemails", "intake", "noshow", "noshows", "unanswered", "nurture", "ok",
  // Trade words of the industries we pitch (manufacturing, construction, retail, health) the 50k lists lack.
  "jobsite", "jobsites", "handrail", "handrails", "woodworking", "woodworker", "bandsaw",
  "tutorial", "tutorials", "oftalmologia", "oftalmologo", "oftalmologica", "storefront", "storefronts",
  "millwork", "drywall", "sitework", "estimator", "estimators", "subcontractor",
  "subcontractors", "telehealth", "telemedicina", "odontologia", "ortodoncia", "dermatologia", "pediatria",
  "planograma", "omnicanal", "mayorista", "mayoristas", "refaccionaria", "refacciones", "asesor", "asesora",
  "asesores", "asesorar",
  // Spanish trade words.
  "agendar", "agende", "agendan", "agenda", "automatizar", "automatizacion", "optimizar", "optimizacion", "prospectos",
  "consultoria", "notaria", "taqueria", "hosteria", "hospedaje", "vacacional", "automotriz", "empaque", "nutricion",
  "fisio", "fisioterapia", "concesionario", "palapa", "anaquel", "redisenar", "intencional", "diagnosticar", "medible",
  "medibles", "dispersa", "disperso", "platicar", "platiquemos", "platica", "agendado", "agendada", "agendadas",
  "agendados", "cotizacion", "cotizaciones", "cotizar", "whatsapps",
  // Tools, platforms and the publishers our benchmarks cite.
  "google", "gmail", "whatsapp", "instagram", "facebook", "linkedin", "tiktok", "youtube", "shopify", "woocommerce",
  "tiendanube", "wordpress", "wix", "squarespace", "hubspot", "baymard", "statista", "wordstream",
  "semrush", "ahrefs", "moz", "lighthouse", "gtmetrix", "yelp", "tripadvisor", "booking", "airbnb", "opentable",
  "calendly", "stripe", "paypal", "mercadolibre", "mercadopago", "expedia", "rappi", "ubereats", "didi",
  // Publishers in 0037 (and the hotel benchmark source HVS), plus words of their names. Some are surnames
  // (bain, gartner, mckinsey, deloitte, wharton, stanford): those pass even capitalized mid-sentence.
  "center", "centre", "institute", "review", "digital", "research",
  "bain", "brightlocal", "clio", "cloudbeds", "cochrane", "deloitte", "drift", "experian", "forrester", "gartner",
  "harvard", "ipsos", "klaviyo", "litmus", "mckinsey", "datamatics", "nucleus", "omnisend",
  "phocuswright", "phocuswire", "portent", "salesforce", "smartsheet", "spiegel", "northwestern", "sprout", "stanford",
  "persuasive", "toast", "wyzowl", "wharton", "systematic", "meta", "analysis", "pulse",
  // The one place our own templates name (beach clubs); a prospect's own city is still caught by the field check.
  "cancun",
];

/**
 * Acronyms we use: they pass written all capitals or all lower case ("SEO",
 * "seo"), never title case, where they read as a name ("Seo", "Ota").
 */
export const OWN_ACRONYMS: readonly string[] = [
  "cta", "ctas", "url", "urls", "seo", "sem", "ppc", "cpc", "cpa", "roi", "roas", "ltv", "crm", "cms", "ux", "ui", "kpi", "kpis", "ota", "otas", "dtc", "bmj", "hbr", "nber", "mit", "hvs", "sku", "skus", "mro", "rfq", "rfqs", "cnc", "hvac",
  "ai", "pdf", "faq", "api", "qr", "iva", "pyme", "pymes", "rfc", "cfdi", "saas", "wifi", "nps", "erp", "tpv", "spei",
];

/**
 * Places and publishers allowed only as the whole phrase, because a word of
 * them is a name ("Quintana", "León", "Bain", "Harvard"). Words are folded;
 * "&" also matches "and" / "y".
 */
export const CAPITALIZED_PHRASES: readonly string[] = [
  "quintana roo", "nuevo leon", "san luis potosi", "prince edward island",
  "harvard business review", "bain & company", "mckinsey & company", "deloitte digital",
  "stanford persuasive technology lab", "spiegel research center", "nucleus research", "baymard institute",
  "sprout social", "experian health", "wharton",
];

/**
 * Words written with a capital in the middle of a sentence that are no
 * prospect's detail, though some are on the names list (Christmas, English,
 * April and Monday are surnames or given names too): months, days, languages,
 * nationalities, holidays, countries and directions. They pass capitalized anywhere.
 */
export const CAPITALIZED_WORDS: readonly string[] = [
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november",
  "december", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  // Not "abril", "mayo", "julio", "agosto", "domingo": Mexican given names ("Abril contesta").
  "enero", "febrero", "marzo", "junio", "septiembre", "octubre", "noviembre", "diciembre", "lunes", "martes",
  "miercoles", "jueves", "viernes", "sabado",
  "english", "spanish", "french", "canadian", "canadians", "mexican", "mexicans", "american", "americans", "latin",
  "christmas", "easter", "thanksgiving", "navidad",
  // Countries, regions and directions ("businesses in Canada", "North America").
  "canada", "mexico", "america", "usa", "north", "south", "east", "west", "norte", "sur", "oriente", "poniente",
  // Provinces and states: a region, never one business. Not the ones that are surnames too (Guerrero,
  // Hidalgo, Morelos, León, Prince Edward): those stay names.
  "ontario", "quebec", "british", "columbia", "alberta", "manitoba", "saskatchewan", "nova", "scotia", "brunswick",
  "newfoundland", "labrador", "island", "yukon", "nunavut", "territories", "jalisco", "nuevo",
  "yucatan", "baja", "california", "sonora", "chihuahua", "coahuila", "tamaulipas",
  "veracruz", "oaxaca", "chiapas", "michoacan", "guanajuato", "queretaro", "puebla",
  "tlaxcala", "sinaloa", "durango", "zacatecas", "nayarit", "colima", "tabasco", "campeche", "aguascalientes",
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
