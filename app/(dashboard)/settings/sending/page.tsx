import { SendingList } from "@/components/settings/sending-list";
import { requireUser } from "@/lib/auth";
import { listBrands, listSenderInboxes } from "@/lib/settings/sending-queries";

export const dynamic = "force-dynamic";

export default async function SettingsSendingPage() {
  const user = await requireUser();
  const [inboxes, brands] = await Promise.all([
    listSenderInboxes(user.tenantId),
    listBrands(user.tenantId),
  ]);

  return <SendingList inboxes={inboxes} brands={brands} canManage={user.role === "admin"} />;
}
