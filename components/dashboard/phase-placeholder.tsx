import { Construction } from "lucide-react";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";

interface PhasePlaceholderProps {
  route: string;
  phase: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  description: string;
}

const PHASE_LABELS: Record<
  0 | 1 | 2 | 3 | 4 | 5 | 6,
  { tone: "neutral" | "accent" | "info"; label: string }
> = {
  0: { tone: "accent", label: "Phase 0 · Foundation" },
  1: { tone: "info", label: "Phase 1 · Discovery" },
  2: { tone: "info", label: "Phase 2 · Research & Scoring" },
  3: { tone: "info", label: "Phase 3 · Pitch & Approve" },
  4: { tone: "info", label: "Phase 4 · Send & Track" },
  5: { tone: "info", label: "Phase 5 · Learn & Multi-channel" },
  6: { tone: "info", label: "Phase 6 · Polish" },
};

export function PhasePlaceholder({ route, phase, title, description }: PhasePlaceholderProps) {
  const meta = PHASE_LABELS[phase];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4">
        <span className="font-mono text-xs text-[var(--color-fg-500)]">{route}</span>
        <Chip tone={meta.tone} className="ml-auto">
          {meta.label}
        </Chip>
      </div>
      <div className="flex-1 p-4">
        <EmptyState
          icon={<Construction className="h-8 w-8" aria-hidden />}
          title={title}
          description={description}
        />
      </div>
    </div>
  );
}
