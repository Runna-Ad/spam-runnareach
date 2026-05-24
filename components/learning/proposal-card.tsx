"use client";

import { useState, useTransition } from "react";
import { reviewProposal } from "@/lib/prompts/actions";
import { VariantDiff } from "./variant-diff";
import type { PromptDetail } from "@/lib/prompts/types";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";

type Proposal = PromptDetail["proposals"][number];

interface Props {
  proposal: Proposal;
}

function formatDate(ts: string) {
  return new Date(ts).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ProposalCard({ proposal }: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function act(action: "approve" | "reject" | "start_ab") {
    setError(null);
    startTransition(async () => {
      const res = await reviewProposal(proposal.id, action);
      if (!res.ok) {
        setError(res.error ?? "Action failed");
      } else {
        setDone(true);
      }
    });
  }

  const evidence = proposal.evidence as Record<string, unknown>;
  const evidenceEntries = Object.entries(evidence);

  if (done) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/40 text-center">
        Action recorded — refreshing data…
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 flex flex-col gap-5 p-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Chip tone="warning">Pending</Chip>
            <span className="text-xs text-white/40">Proposed {formatDate(proposal.proposed_at)}</span>
            <span className="text-xs text-white/30">· Expires {formatDate(proposal.expires_at)}</span>
          </div>
          {proposal.expected_impact && (
            <p className="text-sm font-medium text-white/80">{proposal.expected_impact}</p>
          )}
        </div>
        {proposal.status === "ab_testing" && (
          <Chip tone="info">A/B Running</Chip>
        )}
      </div>

      {/* Evidence */}
      {evidenceEntries.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold text-white/50 uppercase tracking-wide">Evidence</p>
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 grid grid-cols-2 gap-3">
            {evidenceEntries.map(([key, val]) => (
              <div key={key} className="flex flex-col gap-0.5">
                <span className="text-[10px] text-white/30 capitalize">{key.replace(/_/g, " ")}</span>
                <span className="text-sm text-white/70">{String(val)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reasoning */}
      {proposal.reasoning && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-white/50 uppercase tracking-wide">Reasoning</p>
          <p className="text-sm text-white/60 leading-relaxed">{proposal.reasoning}</p>
        </div>
      )}

      {/* Diff */}
      {proposal.current_variant && proposal.proposed_variant && (
        <div className="flex flex-col gap-4">
          <VariantDiff
            label="System prompt delta"
            before={proposal.current_variant.system_prompt}
            after={proposal.proposed_variant.system_prompt}
          />
          <VariantDiff
            label="User template delta"
            before={proposal.current_variant.user_prompt_template}
            after={proposal.proposed_variant.user_prompt_template}
          />
        </div>
      )}

      {/* Error */}
      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1 border-t border-white/10">
        <Button
          size="sm"
          disabled={isPending}
          onClick={() => act("approve")}
        >
          ✓ Approve
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={isPending}
          onClick={() => act("start_ab")}
        >
          ⚡ Start A/B (20%)
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={isPending}
          onClick={() => act("reject")}
          className="text-red-400 hover:text-red-300 hover:bg-red-500/10 ml-auto"
        >
          ✕ Reject
        </Button>
      </div>
    </div>
  );
}
