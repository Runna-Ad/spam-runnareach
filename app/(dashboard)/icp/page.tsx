import { IcpGrid } from "@/components/icp/icp-grid";
import { requireUser } from "@/lib/auth";
import { listIcps } from "@/lib/icp/queries";
import { getIcpSuggestionLists } from "@/lib/icp/suggestions";

export const dynamic = "force-dynamic";

export default async function IcpPage() {
  const user = await requireUser();
  const [icps, tenantSuggestions] = await Promise.all([
    listIcps(user.tenantId),
    getIcpSuggestionLists(user.tenantId),
  ]);

  return (
    <div className="flex h-full flex-col">
      <IcpGrid icps={icps} tenantSuggestions={tenantSuggestions} />
    </div>
  );
}
