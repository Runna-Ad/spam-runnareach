import { CaseStudyGrid } from "@/components/case-studies/case-study-grid";
import { requireUser } from "@/lib/auth";
import {
  listCaseStudies,
  listPainTaxonomy,
  listServices,
} from "@/lib/case-studies/queries";

export const dynamic = "force-dynamic";

export default async function CaseStudiesPage() {
  const user = await requireUser();

  const [caseStudies, painTaxonomy, services] = await Promise.all([
    listCaseStudies(user.tenantId),
    listPainTaxonomy(user.tenantId),
    listServices(user.tenantId),
  ]);

  return (
    <div className="flex h-full flex-col">
      <CaseStudyGrid
        caseStudies={caseStudies}
        painTaxonomy={painTaxonomy}
        services={services}
      />
    </div>
  );
}
