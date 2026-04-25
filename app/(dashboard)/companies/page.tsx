import { CompaniesPage } from "@/components/companies/companies-page";
import { requireUser } from "@/lib/auth";
import { listIcps } from "@/lib/icp/queries";
import { listProspects } from "@/lib/discover/prospects-queries";

export const dynamic = "force-dynamic";

export default async function CompaniesRoute() {
  const user = await requireUser();

  const [prospects, icps] = await Promise.all([
    listProspects(user.tenantId, {}, "newest", 500),
    listIcps(user.tenantId),
  ]);

  return (
    <CompaniesPage
      prospects={prospects}
      icps={icps.map((i) => ({ id: i.id, name: i.name }))}
    />
  );
}
