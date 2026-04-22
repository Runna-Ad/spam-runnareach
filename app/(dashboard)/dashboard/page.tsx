import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function DashboardHome() {
  return (
    <PhasePlaceholder
      route="/dashboard"
      phase={0}
      title="Today queue"
      description="Priority-driven action list lands here. Hot leads, approvals pending, prompt proposals, budget alerts. Not stat cards."
    />
  );
}
