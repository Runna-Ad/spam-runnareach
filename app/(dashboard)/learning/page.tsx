import { requireUser } from "@/lib/auth";
import { listPromptsWithChampions, getPromptDetail } from "@/lib/prompts/queries";
import { LearningClient } from "./learning-client";

export default async function LearningPage() {
  const user = await requireUser();
  const prompts = await listPromptsWithChampions(user.tenantId);

  // Pre-load detail for the first prompt in the list
  const firstPromptId = prompts[0]?.id ?? null;
  const initialDetail = firstPromptId ? await getPromptDetail(firstPromptId) : null;

  return (
    <LearningClient
      prompts={prompts}
      initialDetail={initialDetail}
    />
  );
}
