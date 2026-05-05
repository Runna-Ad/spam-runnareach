import { notFound } from "next/navigation";
import { ProspectDetail } from "@/components/prospects/prospect-detail";
import { requireUser } from "@/lib/auth";
import {
  getProspect,
  getProspectResearch,
  getTopContact,
  listPainTaxonomy,
  listProspectActivity,
  type ActivityEntry,
  type PainOption,
  type ProspectResearch,
} from "@/lib/prospects/detail-queries";

export const dynamic = "force-dynamic";

export default async function ProspectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();

  const prospect = await getProspect(user.tenantId, id);
  if (!prospect) notFound();

  // Research + activity may fail if the migration hasn't been applied — surface
  // that to the UI instead of crashing the page.
  let research: ProspectResearch | null = null;
  let researchTableMissing = false;
  try {
    research = await getProspectResearch(user.tenantId, id);
  } catch (err) {
    if (err instanceof Error && err.message === "PROSPECT_RESEARCH_TABLE_MISSING") {
      researchTableMissing = true;
    } else {
      throw err;
    }
  }

  let activity: ActivityEntry[] = [];
  try {
    activity = await listProspectActivity(user.tenantId, id);
  } catch {
    activity = [];
  }

  let painOptions: PainOption[] = [];
  try {
    painOptions = await listPainTaxonomy(user.tenantId);
  } catch {
    // taxonomy seed missing — picker will fall back to free-text in UI.
    painOptions = [];
  }

  const topContact = await getTopContact(user.tenantId, id).catch(() => null);

  return (
    <ProspectDetail
      prospect={prospect}
      research={research}
      activity={activity}
      painOptions={painOptions}
      researchTableMissing={researchTableMissing}
      canEdit={user.role !== "viewer"}
      topContactEmail={topContact?.email ?? null}
      topContactIsRoleBased={topContact?.is_role_based ?? false}
    />
  );
}
