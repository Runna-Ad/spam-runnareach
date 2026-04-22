import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function CompliancePage() {
  return (
    <PhasePlaceholder
      route="/compliance"
      phase={0}
      title="Compliance"
      description="Per-prospect consent-basis log, unsubscribe list, bounce log, do-not-contact list upload. CASL and LFPDPPP postures."
    />
  );
}
