"use client";

import { useState, useTransition } from "react";
import { fetchPromptDetail } from "@/lib/prompts/actions";
import type { PromptWithChampion, PromptDetail } from "@/lib/prompts/types";
import { PromptList } from "@/components/learning/prompt-list";
import { PromptDetailPanel } from "@/components/learning/prompt-detail";

interface Props {
  prompts: PromptWithChampion[];
  initialDetail: PromptDetail | null;
}

export function LearningClient({ prompts, initialDetail }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(
    initialDetail?.id ?? null,
  );
  const [detail, setDetail] = useState<PromptDetail | null>(initialDetail);
  const [isPending, startTransition] = useTransition();

  function handleSelect(id: string) {
    if (id === selectedId) return;
    setSelectedId(id);
    startTransition(async () => {
      const d = await fetchPromptDetail(id);
      setDetail(d);
    });
  }

  const totalPending = prompts.reduce((s, p) => s + p.pending_proposals, 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page header */}
      <div className="px-6 pt-6 pb-4 border-b border-white/10 flex items-center justify-between gap-4 shrink-0">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-xl font-semibold text-white">Learning</h1>
          <p className="text-sm text-white/40">
            Prompt version control · A/B testing · Sunday analysis proposals
          </p>
        </div>
        {totalPending > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-1.5">
            <span className="text-amber-400 text-sm font-medium">
              {totalPending} proposal{totalPending > 1 ? "s" : ""} pending review
            </span>
          </div>
        )}
      </div>

      {/* Two-column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar — prompt list */}
        <aside className="w-60 shrink-0 border-r border-white/10 overflow-y-auto px-3 py-2">
          <PromptList
            prompts={prompts}
            selectedId={selectedId}
            onSelect={handleSelect}
          />
        </aside>

        {/* Main content — prompt detail */}
        <main className="flex-1 overflow-y-auto px-6 py-6">
          {isPending ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-3 text-white/30">
                <div className="w-5 h-5 rounded-full border-2 border-white/20 border-t-white/60 animate-spin" />
                <p className="text-sm">Loading prompt…</p>
              </div>
            </div>
          ) : detail ? (
            <PromptDetailPanel detail={detail} />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-white/30">Select a prompt to view its details.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
