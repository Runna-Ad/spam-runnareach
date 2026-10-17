import { requireUser } from "@/lib/auth";
import { listHunterScans, getHunterAnalytics } from "@/lib/hunter/queries";
import { listOpportunities } from "@/lib/opportunities/queries";
import { OpportunitiesPage } from "@/components/opportunities/opportunities-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Opportunities" };

export default async function Page() {
  const user = await requireUser();

  const [{ scans, total }, analytics, opportunities] = await Promise.all([
    listHunterScans({ pageSize: 100 }),
    getHunterAnalytics(),
    listOpportunities(user.tenantId),
  ]);

  return <OpportunitiesPage scans={scans} total={total} analytics={analytics} opportunities={opportunities} />;
}
