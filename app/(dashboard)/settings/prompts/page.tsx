import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function SettingsPromptsPage() {
  return (
    <PhasePlaceholder
      route="/settings/prompts"
      phase={2}
      title="Prompts"
      description="Prompt versions (research, scoring, pitch EN/ES, reply-classify, learning-proposal). Champion / challenger status, hit counts, rollback."
    />
  );
}
