import type { Icp, IcpMarket } from "./queries";

export const MARKET_LABEL: Record<IcpMarket, string> = {
  CA: "Canada",
  MX: "Mexico",
  US: "United States",
  LATAM: "LATAM",
};

export const MARKET_FLAG: Record<IcpMarket, string> = {
  CA: "🇨🇦",
  MX: "🇲🇽",
  US: "🇺🇸",
  LATAM: "🌎",
};

export const LANGUAGE_LABEL: Record<"en" | "es", string> = {
  en: "English",
  es: "Español",
};

/**
 * Human-readable employee-size range: "5–50", "≥ 100", "≤ 50", or "—".
 */
export function formatEmployeeRange(icp: Pick<Icp, "employee_size_min" | "employee_size_max">): string {
  const { employee_size_min: lo, employee_size_max: hi } = icp;
  if (lo !== null && hi !== null) return `${lo}–${hi}`;
  if (lo !== null) return `≥ ${lo}`;
  if (hi !== null) return `≤ ${hi}`;
  return "—";
}

/**
 * Human-readable revenue range in USD with k/M/B shorthand.
 */
export function formatRevenueRange(
  icp: Pick<Icp, "revenue_min_usd" | "revenue_max_usd">,
): string {
  const { revenue_min_usd: lo, revenue_max_usd: hi } = icp;
  if (lo === null && hi === null) return "—";
  const fmt = (n: number) => {
    if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
    return `$${n}`;
  };
  if (lo !== null && hi !== null) return `${fmt(lo)}–${fmt(hi)}`;
  if (lo !== null) return `≥ ${fmt(lo)}`;
  return `≤ ${fmt(hi!)}`;
}
