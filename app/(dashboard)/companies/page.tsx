import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function CompaniesPage() {
  return (
    <PhasePlaceholder
      route="/companies"
      phase={1}
      title="Companies"
      description="Filter, sort, bulk actions across all prospects and every pipeline stage. Score-driven sorting, status filters, and research correction handoffs."
    />
  );
}
