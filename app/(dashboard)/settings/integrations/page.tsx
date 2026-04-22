import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function SettingsIntegrationsPage() {
  return (
    <PhasePlaceholder
      route="/settings/integrations"
      phase={0}
      title="Integrations"
      description="Connect Gmail (OAuth), Postmark, Cal.com, Slack, Unipile (LinkedIn), Hunter, SerpAPI, BuiltWith. Token status + revoke."
    />
  );
}
