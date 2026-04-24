import { IcpGrid } from "@/components/icp/icp-grid";
import { requireUser } from "@/lib/auth";
import { listIcps } from "@/lib/icp/queries";

export const dynamic = "force-dynamic";

export default async function IcpPage() {
  const user = await requireUser();
  const icps = await listIcps(user.tenantId);

  return (
    <div className="flex h-full flex-col">
      <IcpGrid icps={icps} />
    </div>
  );
}
