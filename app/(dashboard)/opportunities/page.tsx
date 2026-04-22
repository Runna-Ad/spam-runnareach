import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function OpportunitiesPage() {
  return (
    <PhasePlaceholder
      route="/opportunities"
      phase={5}
      title="Opportunities"
      description="Deal pipeline: Meeting Booked → Discovery Done → Proposal Sent → Negotiation → Won / Lost. Deal value, close date, activity feed, notes."
    />
  );
}
