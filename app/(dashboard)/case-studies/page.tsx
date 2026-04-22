import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function CaseStudiesPage() {
  return (
    <PhasePlaceholder
      route="/case-studies"
      phase={0}
      title="Case studies"
      description="CRUD + pain-taxonomy tagging. Bilingual completeness chips (EN / ES). Logo, hero metric, testimonial quote, measurable results. Goes live once Supabase is wired."
    />
  );
}
