import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function SettingsProfilePage() {
  return (
    <PhasePlaceholder
      route="/settings/profile"
      phase={0}
      title="Profile"
      description="Per-user: name, avatar, signature, timezone. Role badge (Admin / Reviewer / Viewer)."
    />
  );
}
