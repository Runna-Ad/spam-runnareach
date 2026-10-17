import { requireUser } from "@/lib/auth";
import { listPromptsWithChampions, getPromptDetail } from "@/lib/prompts/queries";
import { listLearningArms } from "@/lib/learning/queries";
import { summarizeArms } from "@/lib/learning/report";
import { LearningClient } from "./learning-client";

export default async function LearningPage() {
  const user = await requireUser();
  const [prompts, arms] = await Promise.all([
    listPromptsWithChampions(user.tenantId),
    listLearningArms(user.tenantId),
  ]);

  // Pre-load detail for the first prompt in the list
  const firstPromptId = prompts[0]?.id ?? null;
  const initialDetail = firstPromptId ? await getPromptDetail(firstPromptId) : null;

  return (
    <LearningClient
      prompts={prompts}
      initialDetail={initialDetail}
      learners={summarizeArms(arms)}
    />
  );
}
