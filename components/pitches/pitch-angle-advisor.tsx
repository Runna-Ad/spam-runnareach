"use client";

import { Lightbulb, Loader2, Sparkles } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { suggestPitchAnglesAction } from "@/lib/pitches/angle-advisor";
import type { AngleStrength, PitchAngleResult } from "@/lib/pitches/angle-types";
import { cn } from "@/lib/utils";

const STRENGTH_TONE: Record<AngleStrength, "success" | "info" | "neutral"> = {
  strong: "success",
  moderate: "info",
  exploratory: "neutral",
};

const STRENGTH_LABEL: Record<AngleStrength, string> = {
  strong: "strong",
  moderate: "moderate",
  exploratory: "exploratory",
};

/**
 * Pitch Angle Advisor card (Learning Loop — PHASE 1). Read-only guidance: ranks
 * the strongest pain → case-study → service combos for this prospect, grounded
 * in research + Runna's case studies. Does NOT change pitch generation. Surfaced
 * on both the prospect detail page and the pitches page.
 */
export function PitchAngleAdvisor({
  prospectId,
  compact = false,
}: {
  prospectId: string;
  compact?: boolean;
}) {
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<PitchAngleResult | null>(null);

  const run = async () => {
    setLoading(true);
    try {
      setResult(await suggestPitchAnglesAction(prospectId));
    } catch {
      setResult({
        ok: false,
        prospectName: "",
        angles: [],
        note: "Advisor failed — please try again.",
        method: "insufficient_data",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-bg-800)] p-3",
        compact && "p-2.5",
      )}
    >
      <div className="flex items-center gap-2">
        <Lightbulb className="h-3.5 w-3.5 text-[var(--color-accent-300)]" aria-hidden />
        <span className="text-[11px] font-medium text-[var(--color-fg-300)]">
          Pitch angle advisor
        </span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="ml-auto"
          onClick={run}
          disabled={loading}
          title="Rank the strongest pain → case-study → service angles for this prospect. Guidance only — does not change pitch generation."
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
          )}
          {loading ? "Analyzing…" : result ? "Refresh" : "Suggest angles"}
        </Button>
      </div>

      {!result ? (
        <p className="text-[10px] text-[var(--color-fg-700)]">
          Grounded in this prospect&apos;s research + Runna&apos;s case studies. Suggestion only.
        </p>
      ) : !result.ok ? (
        <p className="text-[11px] italic text-[var(--color-warning-300)]">{result.note}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {result.angles.map((a, i) => (
            <div
              key={`${a.painId ?? a.painLabel}-${i}`}
              className="flex flex-col gap-1 rounded-[var(--radius-sm)] bg-[var(--color-bg-900)] p-2 text-[11px]"
            >
              <div className="flex items-center gap-1.5">
                <Chip tone={STRENGTH_TONE[a.strength]} className="text-[10px]">
                  {STRENGTH_LABEL[a.strength]}
                </Chip>
                <span className="font-medium text-[var(--color-fg-300)]">{a.painLabel}</span>
                {a.caseStudyClient ? (
                  <span className="text-[var(--color-fg-500)]">
                    ↳ {a.caseStudyClient}
                    {a.caseMetric ? ` · ${a.caseMetric}` : ""}
                  </span>
                ) : (
                  <span className="text-[var(--color-fg-500)]">↳ capability + expertise</span>
                )}
                {a.serviceLabel ? (
                  <span className="ml-auto text-[10px] text-[var(--color-accent-300)]">
                    {a.serviceLabel}
                  </span>
                ) : null}
              </div>
              <p className="text-[var(--color-fg-500)]">{a.rationale}</p>
              {a.evidenceQuote ? (
                <p className="truncate italic text-[var(--color-fg-700)]" title={a.evidenceQuote}>
                  “{a.evidenceQuote}”
                </p>
              ) : null}
            </div>
          ))}
          {result.note ? (
            <p className="flex items-start gap-1 text-[10px] text-[var(--color-warning-300)]">
              <span aria-hidden>⚠</span>
              <span>{result.note}</span>
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
