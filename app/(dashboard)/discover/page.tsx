import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function DiscoverPage() {
  return (
    <PhasePlaceholder
      route="/discover"
      phase={1}
      title="Discovery runs"
      description="ICP selector, trigger/monitor runs, reachable-pool preview across Google Places, industry directories, Google search operators, competitor mining, and LinkedIn."
    />
  );
}
