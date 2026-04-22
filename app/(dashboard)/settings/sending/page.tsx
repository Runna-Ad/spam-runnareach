import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function SettingsSendingPage() {
  return (
    <PhasePlaceholder
      route="/settings/sending"
      phase={4}
      title="Sending"
      description="Per-user sending inbox, warming stage, current daily cap, bounce rate, compliance footer preview per market."
    />
  );
}
