"use client";

import { Bot, Check, Loader2, Sparkles, Wand2 } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/input";
import { garyBuildIcpAction } from "@/lib/icp/gary-action";
import type { GaryAnswer, GaryProposedIcp, GaryResponse } from "@/lib/icp/gary-types";

/**
 * "Gary" — guided ICP-building wizard. Gary (an expert ICP/market-research
 * analyst grounded in Runna's real data) asks a couple of sharp questions, then
 * proposes a complete ICP. On apply, the proposal populates the drawer form for
 * the human to review + Save. Never auto-saves.
 */
export function GaryWizard({
  onApply,
  applied,
}: {
  onApply: (icp: GaryProposedIcp) => void;
  /** True once a proposal has been pushed into the form (collapses the wizard). */
  applied: boolean;
}) {
  const [started, setStarted] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [response, setResponse] = React.useState<GaryResponse | null>(null);
  const [answered, setAnswered] = React.useState<GaryAnswer[]>([]);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});

  const callGary = React.useCallback(async (history: GaryAnswer[]) => {
    setLoading(true);
    try {
      setResponse(await garyBuildIcpAction(history));
    } catch {
      setResponse({ phase: "error", message: "Gary is unavailable right now — please try again." });
    } finally {
      setLoading(false);
    }
  }, []);

  const start = () => {
    setStarted(true);
    setAnswered([]);
    setDrafts({});
    void callGary([]);
  };

  const submitAnswers = () => {
    if (response?.phase !== "question") return;
    const newAnswers: GaryAnswer[] = response.questions.map((q) => ({
      question: q.question,
      answer: (drafts[q.id] ?? "").trim(),
    }));
    // Require at least one non-empty answer so Gary has something to work with.
    if (newAnswers.every((a) => !a.answer)) return;
    const merged = [...answered, ...newAnswers.filter((a) => a.answer)];
    setAnswered(merged);
    setDrafts({});
    void callGary(merged);
  };

  if (!started) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--color-accent-300)]/40 bg-[color-mix(in_oklab,var(--color-accent-300),transparent_92%)] p-3">
        <Bot className="h-4 w-4 text-[var(--color-accent-300)]" aria-hidden />
        <div className="flex-1">
          <p className="text-xs font-medium text-[var(--color-fg-200)]">Build with Gary</p>
          <p className="text-[10px] text-[var(--color-fg-500)]">
            An ICP expert who knows Runna&apos;s services + wins. He&apos;ll ask 2-3 questions, then draft the profile.
          </p>
        </div>
        <Button type="button" size="sm" variant="primary" onClick={start}>
          <Wand2 className="h-3.5 w-3.5" aria-hidden /> Start
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-accent-300)]/40 bg-[color-mix(in_oklab,var(--color-accent-300),transparent_94%)] p-3">
      <div className="flex items-center gap-1.5">
        <Bot className="h-4 w-4 text-[var(--color-accent-300)]" aria-hidden />
        <span className="text-xs font-medium text-[var(--color-fg-200)]">Gary · ICP strategist</span>
        {answered.length > 0 ? (
          <span className="ml-auto text-[10px] text-[var(--color-fg-700)]">
            round {Math.min(answered.length + 1, 3)} of 3
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-2 text-[11px] text-[var(--color-fg-500)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Gary is thinking…
        </div>
      ) : null}

      {!loading && response?.phase === "question" ? (
        <div className="flex flex-col gap-3">
          <p className="text-[11px] text-[var(--color-fg-300)]">{response.message}</p>
          {response.questions.map((q) => (
            <div key={q.id} className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-[var(--color-fg-200)]">{q.question}</label>
              {q.hint ? <p className="text-[10px] text-[var(--color-fg-700)]">{q.hint}</p> : null}
              <Input
                value={drafts[q.id] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
                placeholder="Type your answer…"
                className="h-8 text-xs"
              />
              {q.suggestions && q.suggestions.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {q.suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() =>
                        setDrafts((d) => ({
                          ...d,
                          [q.id]: d[q.id] ? `${d[q.id]}, ${s}` : s,
                        }))
                      }
                      className="rounded-[var(--radius-sm)] bg-[var(--color-bg-900)] px-1.5 py-0.5 text-[10px] text-[var(--color-accent-300)] ring-1 ring-inset ring-[var(--color-border-default)] hover:bg-[var(--color-bg-800)]"
                    >
                      + {s}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          <Button type="button" size="sm" variant="primary" className="self-start" onClick={submitAnswers}>
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Send to Gary
          </Button>
        </div>
      ) : null}

      {!loading && response?.phase === "proposal" ? (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] text-[var(--color-fg-300)]">{response.message}</p>
          <div className="rounded-[var(--radius-sm)] bg-[var(--color-bg-900)] p-2 text-[11px]">
            <p className="font-medium text-[var(--color-fg-200)]">{response.icp.name}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              <Chip tone="neutral" className="text-[10px]">{response.icp.market}</Chip>
              {response.icp.industry_tags.slice(0, 6).map((t) => (
                <Chip key={t} tone="accent" className="text-[10px]">{t}</Chip>
              ))}
            </div>
            <p className="mt-1.5 italic text-[var(--color-fg-500)]">{response.rationale}</p>
          </div>
          {applied ? (
            <p className="flex items-center gap-1 text-[11px] text-[var(--color-success-300)]">
              <Check className="h-3.5 w-3.5" aria-hidden /> Applied to the form below — review every field, then Save.
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={() => onApply((response as Extract<GaryResponse, { phase: "proposal" }>).icp)}
              >
                <Check className="h-3.5 w-3.5" aria-hidden /> Apply to form
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={start}>
                Start over
              </Button>
            </div>
          )}
          <p className="text-[10px] text-[var(--color-fg-700)]">
            Gary&apos;s draft is a suggestion — nothing is saved until you review + click Save.
          </p>
        </div>
      ) : null}

      {!loading && response?.phase === "error" ? (
        <p className="text-[11px] italic text-[var(--color-warning-300)]">{response.message}</p>
      ) : null}
    </div>
  );
}
