import { headers } from "next/headers";
import { UsersPage } from "@/components/settings/users-page";
import { requireUser } from "@/lib/auth";
import { listMembers, listPendingInvitations } from "@/lib/settings/users-queries";

export const dynamic = "force-dynamic";

export default async function SettingsUsersPage() {
  const user = await requireUser();

  const [members, invitations, h] = await Promise.all([
    listMembers(user.tenantId),
    listPendingInvitations(user.tenantId),
    headers(),
  ]);

  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const baseUrl = `${proto}://${host}`;

  return (
    <UsersPage
      currentUserId={user.id}
      currentUserRole={user.role}
      members={members}
      invitations={invitations}
      baseUrl={baseUrl}
    />
  );
}
