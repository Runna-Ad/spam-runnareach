/**
 * Where each discovery source should look for one run.
 *
 * A manual run searches the ICP's broad area (first province, or the whole
 * country for Mexico). An autopilot run searches ONE region the scout chose,
 * and every source has to honour it, or the scout credits "spa × Nuevo León"
 * with spas from Mexico City and learns nothing about either place.
 *
 * Pure — tested in tests/search-geo.test.ts.
 */

export const CANADIAN_PROVINCES = new Set([
  "Alberta", "British Columbia", "Manitoba", "New Brunswick",
  "Newfoundland and Labrador", "Northwest Territories", "Nova Scotia",
  "Nunavut", "Ontario", "Prince Edward Island", "Quebec", "Saskatchewan", "Yukon",
]);

// Yellow Pages takes a province; a city cell searches its province there.
const CA_CITY_PROVINCE: Record<string, string> = {
  calgary: "Alberta", edmonton: "Alberta", "red deer": "Alberta", lethbridge: "Alberta",
  vancouver: "British Columbia", victoria: "British Columbia", surrey: "British Columbia",
  burnaby: "British Columbia", kelowna: "British Columbia",
  toronto: "Ontario", ottawa: "Ontario", mississauga: "Ontario", hamilton: "Ontario",
  london: "Ontario", kitchener: "Ontario", waterloo: "Ontario",
  montreal: "Quebec", "montréal": "Quebec", "quebec city": "Quebec", laval: "Quebec",
  winnipeg: "Manitoba", regina: "Saskatchewan", saskatoon: "Saskatchewan", halifax: "Nova Scotia",
};

export type SearchGeo = {
  /** Yellow Pages location: a province name or "Canada". */
  yp: string;
  /**
   * Google Places location: an INEGI state code for Mexico (the crawl turns it
   * into "Nuevo León, Mexico" plus a location bias), else "Place, Country".
   */
  places: string;
  /** Geo words for the Brave query. */
  brave: string;
};

export function searchGeo(
  market: "CA" | "MX" | "US",
  icpRegions: string[],
  focusRegion: string | null,
  mxStateCodes: Record<string, string>,
): SearchGeo {
  const focus = focusRegion?.trim() || null;
  const province = (r: string) => (CANADIAN_PROVINCES.has(r) ? r : CA_CITY_PROVINCE[r.toLowerCase()]);
  const yp = (focus ? province(focus) : icpRegions.find((r) => CANADIAN_PROVINCES.has(r))) ?? "Canada";

  if (market === "MX") {
    if (!focus) return { yp, places: "Mexico", brave: "Mexico" };
    return { yp, places: mxStateCodes[focus] ?? `${focus}, Mexico`, brave: focus };
  }
  if (market === "US") {
    return focus
      ? { yp, places: `${focus}, United States`, brave: focus }
      : { yp, places: "United States", brave: "United States" };
  }
  if (focus) return { yp, places: `${focus}, Canada`, brave: focus };
  return { yp, places: yp === "Canada" ? "Canada" : `${yp}, Canada`, brave: yp };
}
