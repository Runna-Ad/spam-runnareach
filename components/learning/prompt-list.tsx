"use client";

import { cn } from "@/lib/utils";
import { PURPOSE_LABELS, PURPOSE_GROUPS } from "@/lib/prompts/types";
import type { PromptWithChampion } from "@/lib/prompts/types";
import { Chip } from "@/components/ui/chip";

interface Props {
  prompts: PromptWithChampion[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function PromptList({ prompts, selectedId, onSelect }: Props) {
  const promptByPurpose = new Map(prompts.map((p) => [p.purpose, p]));

  return (
    <nav className="flex flex-col gap-6 py-2">
      {PURPOSE_GROUPS.map((group) => {
        const groupPrompts = group.purposes
          .map((p) => promptByPurpose.get(p))
          .filter(Boolean) as PromptWithChampion[];

        if (groupPrompts.length === 0) return null;

        return (
          <div key={group.label}>
            <p className="px-3 mb-1 text-[10px] font-semibold tracking-widest uppercase text-white/30">
              {group.label}
            </p>
            <div className="flex flex-col gap-0.5">
              {groupPrompts.map((prompt) => (
                <button
                  key={prompt.id}
                  onClick={() => onSelect(prompt.id)}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition-colors",
                    selectedId === prompt.id
                      ? "bg-white/10 text-white"
                      : "text-white/60 hover:bg-white/5 hover:text-white/90",
                  )}
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium truncate">
                      {PURPOSE_LABELS[prompt.purpose]}
                    </span>
                    <span className="text-[11px] text-white/40 truncate">
                      {prompt.champion ? `v${prompt.champion.version}` : "no champion"}{" "}
                      · {prompt.champion?.model?.split("-").slice(1, 3).join("-") ?? "—"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {prompt.pending_proposals > 0 && (
                      <span className="flex items-center justify-center rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-semibold w-4 h-4">
                        {prompt.pending_proposals}
                      </span>
                    )}
                    {!prompt.is_active && (
                      <Chip tone="neutral">off</Chip>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}
