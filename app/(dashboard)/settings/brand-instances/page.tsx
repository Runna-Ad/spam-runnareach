import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function SettingsBrandInstancesPage() {
  return (
    <PhasePlaceholder
      route="/settings/brand-instances"
      phase={0}
      title="Brand instances"
      description="Runna CA (Canada) + Rünna (Mexico). Per-brand signature, compliance footer, sending domain, case-study subset visibility."
    />
  );
}
