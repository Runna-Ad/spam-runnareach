import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function IcpPage() {
  return (
    <PhasePlaceholder
      route="/icp"
      phase={0}
      title="Ideal customer profiles"
      description="Market-aware form (CA / MX / US / LATAM). Industry, geo, size, business type, language. Places reachable-pool preview before committing an ICP."
    />
  );
}
