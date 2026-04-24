/**
 * Curated shortlist of timezones Runna CA operators actually use. The full
 * IANA list is too long to render as a Select. Pedro / teammates that work
 * out of another zone pick "Other…" and free-type the IANA identifier.
 */
export const COMMON_TIMEZONES = [
  "America/Edmonton",
  "America/Vancouver",
  "America/Toronto",
  "America/Mexico_City",
  "America/Los_Angeles",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Madrid",
  "UTC",
] as const;

export function isCommonTimezone(tz: string): boolean {
  return COMMON_TIMEZONES.includes(tz as (typeof COMMON_TIMEZONES)[number]);
}
