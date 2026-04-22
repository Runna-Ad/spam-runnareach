import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function PitchesPage() {
  return (
    <PhasePlaceholder
      route="/pitches"
      phase={3}
      title="Approval queue"
      description="Keyboard-driven focus mode. A / E / R / S to approve, edit, reject, skip. Three tiers: quick-send, review, deep-edit. Three variants per prospect."
    />
  );
}
