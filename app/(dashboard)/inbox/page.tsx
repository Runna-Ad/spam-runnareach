import { InboxPage } from "@/components/inbox/inbox-page";
import { requireUser } from "@/lib/auth";
import {
  getInboxCounts,
  listProspectsForPicker,
  listReplies,
  REPLIES_MIGRATION_MISSING_CODE,
  type Reply,
} from "@/lib/replies/queries";

export const dynamic = "force-dynamic";

export default async function InboxRoute() {
  const user = await requireUser();

  let replies: Reply[] = [];
  let migrationMissing = false;
  try {
    replies = await listReplies(user.tenantId);
  } catch (err) {
    if (err instanceof Error && err.message === REPLIES_MIGRATION_MISSING_CODE) {
      migrationMissing = true;
    } else {
      throw err;
    }
  }

  const [prospects, counts] = await Promise.all([
    listProspectsForPicker(user.tenantId),
    getInboxCounts(user.tenantId),
  ]);

  return (
    <InboxPage
      replies={replies}
      prospects={prospects}
      counts={counts}
      migrationMissing={migrationMissing}
      canEdit={user.role !== "viewer"}
    />
  );
}
