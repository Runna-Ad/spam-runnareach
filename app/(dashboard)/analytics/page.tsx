import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function AnalyticsPage() {
  return (
    <PhasePlaceholder
      route="/analytics"
      phase={5}
      title="Analytics"
      description="Reply rates by ICP, service, case study, subject style, time-of-day, sender. Deliverability dashboard tab. Case-study leaderboard."
    />
  );
}
