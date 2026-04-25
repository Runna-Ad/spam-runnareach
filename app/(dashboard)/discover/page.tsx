import { DiscoverPage } from "@/components/discover/discover-page";
import { requireUser } from "@/lib/auth";
import { listIcps } from "@/lib/icp/queries";
import { listDiscoveryRuns } from "@/lib/discover/runs-queries";

export const dynamic = "force-dynamic";

export default async function DiscoverRoute() {
  const user = await requireUser();

  const [runs, icps] = await Promise.all([
    listDiscoveryRuns(user.tenantId),
    listIcps(user.tenantId),
  ]);

  return (
    <DiscoverPage
      runs={runs}
      icps={icps
        .filter((i) => i.is_active)
        .map((i) => ({ id: i.id, name: i.name, market: i.market }))}
      canManage={user.role !== "viewer"}
    />
  );
}
