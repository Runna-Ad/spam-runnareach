import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <PhasePlaceholder
      route={`/companies/${id}`}
      phase={2}
      title="Prospect detail"
      description="Research brief, pain taxonomy, pitches, activity. Research Correction Loop lets reviewers edit research and resubmit for re-scoring and re-pitching."
    />
  );
}
