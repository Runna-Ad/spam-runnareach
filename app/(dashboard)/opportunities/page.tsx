import { requireUser } from "@/lib/auth";
import { listHunterScans, getHunterAnalytics } from "@/lib/hunter/queries";
import { OpportunitiesPage } from "@/components/opportunities/opportunities-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Opportunities" };

export default async function Page() {
  await requireUser();

  const [{ scans, total }, analytics] = await Promise.all([
    listHunterScans({ pageSize: 100 }),
    getHunterAnalytics(),
  ]);

  return <OpportunitiesPage scans={scans} total={total} analytics={analytics} />;
}
