import { PitchesPage } from "@/components/pitches/pitches-page";
import { requireUser } from "@/lib/auth";
import { getPitchCounts, listPitches } from "@/lib/pitches/queries";

export const dynamic = "force-dynamic";

export default async function PitchesRoute() {
  const user = await requireUser();
  const [pitches, counts] = await Promise.all([
    listPitches(user.tenantId),
    getPitchCounts(user.tenantId),
  ]);
  return (
    <PitchesPage
      pitches={pitches}
      counts={counts}
      canEdit={user.role !== "viewer"}
    />
  );
}
