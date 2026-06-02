import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { IntegrationsPage, type IntegrationStatus } from "@/components/settings/integrations-page";

export const metadata = { title: "Integrations" };

export default async function SettingsIntegrationsPage() {
  await requireUser();

  const supabase = await createClient();

  // Check Gmail: any sender_inbox with a non-null gmail_refresh_token_encrypted
  const { data: gmailRow } = await supabase
    .from("sender_inboxes")
    .select("email")
    .not("gmail_refresh_token_encrypted", "is", null)
    .limit(1)
    .maybeSingle();

  const status: IntegrationStatus = {
    gmailConnected: gmailRow !== null,
    gmailEmail: gmailRow?.email ?? null,
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    braveConfigured: Boolean(process.env.BRAVE_SEARCH_API_KEY),
    hunterConfigured: Boolean(process.env.HUNTER_API_KEY),
    anymailConfigured: Boolean(process.env.ANYMAIL_FINDER_API_KEY),
  };

  return <IntegrationsPage status={status} />;
}
