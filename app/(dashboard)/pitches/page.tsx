import { PitchesPage } from "@/components/pitches/pitches-page";
import { requireUser } from "@/lib/auth";
import { getPitchCounts, listPitches } from "@/lib/pitches/queries";
import { listSenderInboxes } from "@/lib/settings/sending-queries";

export const dynamic = "force-dynamic";

export default async function PitchesRoute() {
  const user = await requireUser();
  const [pitches, counts, inboxes] = await Promise.all([
    listPitches(user.tenantId),
    getPitchCounts(user.tenantId),
    listSenderInboxes(user.tenantId),
  ]);
  return (
    <PitchesPage
      pitches={pitches}
      counts={counts}
      canEdit={user.role !== "viewer"}
      inboxes={inboxes}
    />
  );
}
