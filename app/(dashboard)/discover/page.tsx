import { DiscoverPage } from "@/components/discover/discover-page";
import { requireUser } from "@/lib/auth";
import { listIcps } from "@/lib/icp/queries";
import { listDiscoveryRuns } from "@/lib/discover/runs-queries";
import { braveIsAvailable } from "@/lib/discover/sources/brave-search";
import { denueIsAvailable } from "@/lib/discover/sources/denue";
import { yelpIsAvailable } from "@/lib/discover/sources/yelp";
import { googlePlacesIsAvailable } from "@/lib/discover/sources/google-places";
import type { CrawlableSource } from "@/lib/discover/source-meta";

export const dynamic = "force-dynamic";

export default async function DiscoverRoute() {
  const user = await requireUser();

  const [runs, icps] = await Promise.all([
    listDiscoveryRuns(user.tenantId),
    listIcps(user.tenantId),
  ]);

  // Resolve which crawl sources have credentials at runtime
  const availableCrawlSources: CrawlableSource[] = [
    "yellowpages_ca", // always available — no key needed
    ...(braveIsAvailable() ? (["brave_search"] as CrawlableSource[]) : []),
    ...(denueIsAvailable() ? (["denue"] as CrawlableSource[]) : []),
    ...(yelpIsAvailable() ? (["yelp"] as CrawlableSource[]) : []),
    ...(googlePlacesIsAvailable() ? (["google_places"] as CrawlableSource[]) : []),
  ];

  return (
    <DiscoverPage
      runs={runs}
      icps={icps
        .filter((i) => i.is_active)
        .map((i) => ({ id: i.id, name: i.name, market: i.market }))}
      canManage={user.role !== "viewer"}
      availableCrawlSources={availableCrawlSources}
    />
  );
}
