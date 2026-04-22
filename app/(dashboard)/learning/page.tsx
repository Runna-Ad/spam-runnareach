import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function LearningPage() {
  return (
    <PhasePlaceholder
      route="/learning"
      phase={5}
      title="Learning"
      description="Sunday prompt-tweak proposals with diff, evidence, and impact estimate. Approve, A/B, or reject. Prompt version history with rollback."
    />
  );
}
