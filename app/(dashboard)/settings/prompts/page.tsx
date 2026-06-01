import { requireUser } from "@/lib/auth";
import { listPromptsWithChampions } from "@/lib/prompts/queries";
import { PromptsPage } from "@/components/settings/prompts-page";

export const dynamic = "force-dynamic";

export default async function SettingsPromptsPage() {
  const user = await requireUser();
  const prompts = await listPromptsWithChampions(user.tenantId);

  return <PromptsPage prompts={prompts} />;
}
