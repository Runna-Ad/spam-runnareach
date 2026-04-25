import { FunnelBoard } from "@/components/funnel/funnel-board";
import { requireUser } from "@/lib/auth";
import { listFunnelCards } from "@/lib/funnel/queries";

export const dynamic = "force-dynamic";

export default async function FunnelPage() {
  const user = await requireUser();
  const cards = await listFunnelCards(user.tenantId);

  return <FunnelBoard cards={cards} canEdit={user.role !== "viewer"} />;
}
