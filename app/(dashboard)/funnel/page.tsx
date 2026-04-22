import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function FunnelPage() {
  return (
    <PhasePlaceholder
      route="/funnel"
      phase={4}
      title="Funnel kanban"
      description="Drag-drop pipeline stages. WIP limits per stage. Conversion rates between every pair of stages."
    />
  );
}
