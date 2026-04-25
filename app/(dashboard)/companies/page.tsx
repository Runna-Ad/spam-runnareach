import { CompaniesPage } from "@/components/companies/companies-page";
import { requireUser } from "@/lib/auth";
import { listIcps } from "@/lib/icp/queries";
import { listProspects } from "@/lib/discover/prospects-queries";

export const dynamic = "force-dynamic";

const VALID_STATUSES = new Set([
  "raw",
  "researched",
  "pitched",
  "replied",
  "meeting_booked",
  "won",
  "lost",
  "suppressed",
]);
const VALID_MARKETS = new Set(["CA", "MX", "US", "LATAM"]);
const VALID_SORTS = new Set(["newest", "oldest", "score_desc", "score_asc", "name"]);

/**
 * Read + sanitize the URL filter params, defaulting any unknown value to "ALL".
 * Lets links like /companies?status=raw or /companies?market=CA pre-filter
 * without trusting the raw input.
 */
function parseFilters(searchParams: Record<string, string | string[] | undefined>) {
  const get = (key: string) => {
    const v = searchParams[key];
    return Array.isArray(v) ? v[0] : v;
  };
  const status = get("status");
  const market = get("market");
  const icpId = get("icp");
  const sort = get("sort");
  const search = get("q") ?? "";
  return {
    status: status && VALID_STATUSES.has(status) ? status : "ALL",
    market: market && VALID_MARKETS.has(market) ? market : "ALL",
    icpId: icpId ?? "ALL",
    sort: sort && VALID_SORTS.has(sort) ? sort : "newest",
    search: typeof search === "string" ? search.slice(0, 200) : "",
  };
}

export default async function CompaniesRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const initial = parseFilters(sp);

  const [prospects, icps] = await Promise.all([
    listProspects(user.tenantId, {}, "newest", 500),
    listIcps(user.tenantId),
  ]);

  // ICP id only carries through if the tenant actually owns that ICP.
  const validIcpIds = new Set(icps.map((i) => i.id));
  const initialIcpId =
    initial.icpId !== "ALL" && validIcpIds.has(initial.icpId) ? initial.icpId : "ALL";

  return (
    <CompaniesPage
      prospects={prospects}
      icps={icps.map((i) => ({ id: i.id, name: i.name }))}
      initialFilters={{
        status: initial.status,
        market: initial.market,
        icpId: initialIcpId,
        sort: initial.sort,
        search: initial.search,
      }}
    />
  );
}
