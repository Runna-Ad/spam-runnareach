/**
 * DENUE — Directorio Estadístico Nacional de Unidades Económicas
 *
 * Mexico's official government business registry, maintained by INEGI.
 * ~5 million businesses searchable by activity code (SCIAN), state, and
 * business name. Free API — register at:
 *   https://www.inegi.org.mx/app/api/denue/v1/doc/
 *
 * Env var: DENUE_API_KEY
 * Register at: https://www.inegi.org.mx/servicios/api_denue.html
 * (If registration link is broken, email atencion@inegi.org.mx to request a token)
 *
 * Endpoint used:
 *   GET /consulta/Buscar/{nombre_estab}/{codigo_act}/{id_estado}/{municipio}/{tipo}/{max}/{token}
 *
 * Search modes (auto-detected from `keyword`):
 *   - Numeric keyword (e.g. "46", "5411") → used as SCIAN codigo_act, nombre_estab="0"
 *   - Text keyword (e.g. "restaurante")    → used as nombre_estab, codigo_act="0"
 */

import { normalizeDomain } from "../fuzzy-dedupe";

const BASE_URL = "https://www.inegi.org.mx/app/api/denue/v1/consulta";
const FETCH_TIMEOUT_MS = 20_000;

// ── Public types ───────────────────────────────────────────────────────────────

export type DenueListing = {
  company_name: string;
  website_url: string | null;
  domain: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  state: string | null; // full state name (entidad)
  state_code: string | null; // "09", "14", etc.
  activity_code: string | null; // SCIAN code
  activity_name: string | null;
  employee_range: string | null; // "31 a 50 personas"
};

export type DenueSearchInput = {
  /** Business name to search, OR a SCIAN activity code (numeric string like "46", "5411"). */
  keyword: string;
  /** INEGI state code "09", "14", "19" — or "0" for all Mexico. Defaults to "0". */
  stateCode?: string;
  /** Max results to return. DENUE caps at ~1000. Default 100. */
  maxResults?: number;
};

export type DenueSearchResult =
  | { ok: true; listings: DenueListing[]; total_returned: number }
  | { ok: false; error: string };

// ── INEGI state code map ───────────────────────────────────────────────────────

export const MEXICO_STATE_CODES: Record<string, string> = {
  "Aguascalientes": "01",
  "Baja California": "02",
  "Baja California Sur": "03",
  "Campeche": "04",
  "Coahuila": "05",
  "Coahuila de Zaragoza": "05",
  "Colima": "06",
  "Chiapas": "07",
  "Chihuahua": "08",
  "Ciudad de México": "09",
  "CDMX": "09",
  "DF": "09",
  "Durango": "10",
  "Guanajuato": "11",
  "Guerrero": "12",
  "Hidalgo": "13",
  "Jalisco": "14",
  "México": "15",
  "Estado de México": "15",
  "Michoacán": "16",
  "Michoacán de Ocampo": "16",
  "Morelos": "17",
  "Nayarit": "18",
  "Nuevo León": "19",
  "Oaxaca": "20",
  "Puebla": "21",
  "Querétaro": "22",
  "Quintana Roo": "23",
  "San Luis Potosí": "24",
  "Sinaloa": "25",
  "Sonora": "26",
  "Tabasco": "27",
  "Tamaulipas": "28",
  "Tlaxcala": "29",
  "Veracruz": "30",
  "Veracruz de Ignacio de la Llave": "30",
  "Yucatán": "31",
  "Zacatecas": "32",
  // City → state fallbacks (cities not already listed as states above)
  "Monterrey": "19",
  "Guadalajara": "14",
  "Zapopan": "14",
  "Tijuana": "02",
  "Ciudad Juárez": "08",
  "León": "11",
  "Mérida": "31",
};

/** Maps ICP geo_regions entries to INEGI state codes. Returns first match, else "0". */
export function deriveMexicoStateCode(geoRegions: string[]): string {
  for (const region of geoRegions) {
    const code = MEXICO_STATE_CODES[region];
    if (code) return code;
  }
  return "0"; // all Mexico
}

/**
 * Maps ICP industry_tags to a SCIAN broad sector code.
 * Returns the most specific code that fits the first matching tag.
 */
export const INDUSTRY_TO_SCIAN: Record<string, string> = {
  // Retail / E-commerce
  "dtc": "46",
  "ecommerce": "46",
  "moda": "4631",
  "cosmetica": "4644",
  "hogar": "4659",
  "productos de consumo": "46",
  "retail": "46",
  "clothing": "4631",
  "food": "461",
  "bebidas": "461",
  // Professional services
  "legal": "5411",
  "abogados": "5411",
  "contabilidad": "5412",
  "auditoria": "5412",
  "consultoria": "5416",
  "consultoría": "5416",
  "servicios financieros": "5231",
  "agencias": "5418",
  "marketing": "5418",
  "publicidad": "5418",
  // Hospitality
  "restaurante": "7221",
  "restaurants": "7221",
  "hosteleria": "7211",
  // Technology
  "tecnologia": "5415",
  "software": "5415",
  "tech": "5415",
};

export function deriveScianCode(industryTags: string[]): string {
  for (const tag of industryTags) {
    const code = INDUSTRY_TO_SCIAN[tag.toLowerCase()];
    if (code) return code;
  }
  return "0"; // all activities
}

// ── Availability check ─────────────────────────────────────────────────────────

export function denueIsAvailable(): boolean {
  return !!process.env.DENUE_API_KEY;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function searchDenue(input: DenueSearchInput): Promise<DenueSearchResult> {
  const apiKey = process.env.DENUE_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "DENUE_API_KEY not set — register at inegi.org.mx/servicios/api_denue.html (or email atencion@inegi.org.mx)" };
  }

  // State code: the API wants "01".."32", or "00" for the whole country.
  // Our callers pass "0" for "all Mexico" — translate it.
  const rawState = input.stateCode ?? "0";
  const stateCode = rawState === "0" || rawState === "" ? "00" : rawState.padStart(2, "0");
  const maxResults = Math.min(input.maxResults ?? 100, 1000);

  // BuscarEntidad/{condition}/{state}/{start}/{end}/{token} — a keyword search
  // scoped to one state.
  //
  // The previous URL was /Buscar/{name}/{scian}/{state}/0/0/{max}/{token}, which
  // matches NO documented DENUE v1 method — `Buscar` is actually a GEOGRAPHIC
  // search (condition/lat,lon/radius/token). INEGI answered it with its HTML
  // "Página no encontrada" page, which is why this source has never returned a
  // single row. Verified against INEGI's own API documentation.
  //
  // A numeric SCIAN code isn't usable here (that needs BuscarAreaAct's 14
  // positional parameters); callers pass a text keyword, which is what
  // BuscarEntidad wants anyway.
  const condition = encodeURIComponent(input.keyword.trim() || "todos");
  const url = `${BASE_URL}/BuscarEntidad/${condition}/${stateCode}/1/${maxResults}/${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: {
        // NO Accept header. Sending `Accept: application/json` makes INEGI
        // answer 406 Not Acceptable — reproduced from a residential IP, so it
        // is content negotiation, NOT the datacenter-IP block previously
        // assumed here. The endpoint returns JSON regardless.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      if (res.status === 404) {
        // INEGI serves its 404 page both for invalid tokens and (historically)
        // for blocked source IPs.
        return {
          ok: false,
          error:
            "DENUE API returned 404 — the token is likely invalid/expired (INEGI serves a 404 page for bad tokens). Regenerate it at inegi.org.mx/servicios/api_denue.html and update DENUE_API_KEY.",
        };
      }
      if (res.status === 406) {
        // Caused by sending `Accept: application/json` (reproduced from a
        // residential IP — it is NOT a datacenter/IP block, as this message
        // previously claimed). We no longer send that header, so a 406 here
        // means something re-introduced it.
        return {
          ok: false,
          error:
            "DENUE returned 406 Not Acceptable — this happens when an Accept header is sent. " +
            "The request should send no Accept header at all.",
        };
      }
      if (res.status === 403) {
        return { ok: false, error: "DENUE rejected the request (HTTP 403)." };
      }
      if (res.status === 501) {
        return {
          ok: false,
          error:
            "DENUE rejected the query parameters (HTTP 501 'Consulta incorrecta') — " +
            "the endpoint path or its positional parameters are wrong for this method.",
        };
      }
      return { ok: false, error: `DENUE API returned HTTP ${res.status}` };
    }

    const text = await res.text();

    // INEGI sometimes returns a 200 with an HTML "not found" page for non-MX IPs
    if (text.includes("Página no encontrada") || text.includes("File or directory not found")) {
      return {
        ok: false,
        error: "DENUE API unreachable — INEGI restricts access to Mexican IP addresses. Use a MX VPN for local testing, or deploy to a server in Mexico.",
      };
    }

    // DENUE returns plain text "No hay resultados" when empty
    if (text.trim().startsWith("No hay") || text.trim() === "") {
      return { ok: true, listings: [], total_returned: 0 };
    }

    let raw: unknown[];
    try {
      raw = JSON.parse(text) as unknown[];
    } catch {
      return { ok: false, error: `DENUE response parse error: ${text.slice(0, 200)}` };
    }

    const listings: DenueListing[] = raw.map((item) => {
      const r = item as Record<string, string>;

      const rawSite = (r.sitio_web ?? "").trim();
      const website_url = normalizeWebsite(rawSite);
      const domain = website_url ? normalizeDomain(website_url) : null;

      // Build state code from entidad name
      const entidad = (r.entidad ?? "").trim();
      const state_code = MEXICO_STATE_CODES[entidad] ?? null;

      return {
        company_name: titleCase(r.nom_estab ?? r.raz_social ?? ""),
        website_url,
        domain,
        phone: (r.telefono ?? "").trim() || null,
        email: (r.correoelec ?? "").trim() || null,
        city: titleCase(r.municipio ?? r.nom_loc ?? ""),
        state: entidad || null,
        state_code,
        activity_code: (r.codigo_act ?? "").trim() || null,
        activity_name: (r.nombre_act ?? "").trim() || null,
        employee_range: (r.per_ocu ?? "").trim() || null,
      };
    }).filter((l) => l.company_name.length > 1);

    return { ok: true, listings, total_returned: listings.length };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "DENUE request timed out (20 s)" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    // INEGI intermittently emits a MALFORMED HTTP response that no standard
    // client can parse (curl: "Unsupported response code in HTTP response";
    // Node fetch: "fetch failed"). Reproduced from a residential IP minutes
    // after the same endpoint answered normally — it is a server-side fault on
    // INEGI's end, not a geo/IP restriction as previously assumed here.
    if (msg.includes("fetch failed") || msg.includes("network") || msg.includes("ECONNRESET")) {
      return {
        ok: false,
        error:
          "DENUE sent a malformed HTTP response (INEGI server fault — intermittent). " +
          "Nothing to fix on our side; retry later or leave DENUE disabled.",
      };
    }
    return { ok: false, error: `DENUE error: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeWebsite(raw: string): string | null {
  if (!raw || raw === "0") return null;
  try {
    const withProto = raw.startsWith("http") ? raw : `https://${raw}`;
    const u = new URL(withProto);
    return `https://${u.hostname}`;
  } catch {
    return null;
  }
}

/**
 * Convert ALL CAPS to Title Case (DENUE returns uppercase legal names) and
 * strip trailing legal-entity suffixes — an email greeting "Abarrotes Don
 * Jose Sa De Cv" reads as a bot that scraped a government registry (it did).
 */
function titleCase(str: string): string {
  if (!str) return str;
  const cased = str
    .toLowerCase()
    .replace(/(?:^|\s|[-/])\S/g, (c) => c.toUpperCase())
    .trim();
  return cased
    .replace(/[,\s]+(S\.?a\.?p\.?i\.?\s+De\s+C\.?v\.?|S\.?a\.?\s+De\s+C\.?v\.?|S\.?\s+De\s+R\.?l\.?(\s+De\s+C\.?v\.?)?|S\.?a\.?b?\.?|S\.?c\.?|A\.?c\.?|S\.?\s+En\s+C\.?)\.?$/i, "")
    .trim();
}
