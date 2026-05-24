import { SendingList } from "@/components/settings/sending-list";
import { requireUser } from "@/lib/auth";
import { listBrands, listSenderInboxes } from "@/lib/settings/sending-queries";

export const dynamic = "force-dynamic";

const GMAIL_ERROR_LABELS: Record<string, string> = {
  token_exchange_failed: "Token exchange failed — check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
  no_refresh_token: "No refresh token returned. Try revoking access at myaccount.google.com/permissions and reconnecting.",
  encryption_failed: "Token encryption failed — check TOKEN_ENCRYPTION_KEY.",
  db_update_failed: "Failed to save token to database.",
  inbox_not_found: "Inbox not found.",
  missing_credentials: "Server credentials not configured.",
  missing_params: "OAuth callback missing required parameters.",
};

export default async function SettingsSendingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const gmailError = params.gmail_error
    ? (GMAIL_ERROR_LABELS[params.gmail_error] ?? `OAuth error: ${params.gmail_error}`) +
      (params.google_err ? ` — Google: ${params.google_err}` : "")
    : null;
  const gmailConnected = params.gmail_connected === "1";

  const [inboxes, brands] = await Promise.all([
    listSenderInboxes(user.tenantId),
    listBrands(user.tenantId),
  ]);

  return (
    <SendingList
      inboxes={inboxes}
      brands={brands}
      canManage={user.role === "admin"}
      gmailError={gmailError}
      gmailConnected={gmailConnected}
    />
  );
}
