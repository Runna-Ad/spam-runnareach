import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function SettingsUsersPage() {
  return (
    <PhasePlaceholder
      route="/settings/users"
      phase={0}
      title="Users"
      description="Invite and manage SAGA team access. Roles: Admin / Reviewer / Viewer. Per-user sending inbox binding. Audit log."
    />
  );
}
