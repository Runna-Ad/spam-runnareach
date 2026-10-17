"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { markOpportunityLost, markOpportunityWon } from "@/lib/opportunities/actions";
import { describeOutcome, isClosedStage } from "@/lib/opportunities/outcome";
import type { OpportunityRow } from "@/lib/opportunities/queries";
import React from "react";
import { toast } from "sonner";

const STAGE_LABEL: Record<string, string> = {
  meeting_booked: "Meeting booked",
  discovery_done: "Discovery done",
  proposal_sent: "Proposal sent",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

function stageTone(stage: string): "success" | "danger" | "info" {
  if (stage === "won") return "success";
  if (stage === "lost") return "danger";
  return "info";
}

type Editing = { id: string; mode: "won" | "lost" } | null;

function OpportunityItem({ opp }: { opp: OpportunityRow }) {
  const [editing, setEditing] = React.useState<Editing>(null);
  const [value, setValue] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const closed = isClosedStage(opp.stage);

  function submit(mode: "won" | "lost") {
    startTransition(async () => {
      const res =
        mode === "won"
          ? await markOpportunityWon({
              id: opp.id,
              deal_value_cad: value.trim() === "" ? Number.NaN : Number(value),
            })
          : await markOpportunityLost({ id: opp.id, loss_reason: reason });
      if (res.ok) {
        toast.success(mode === "won" ? "Marked won" : "Marked lost");
        setEditing(null);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-[var(--color-fg-50)]">
              {opp.company_name}
            </span>
            <Chip tone={stageTone(opp.stage)}>{STAGE_LABEL[opp.stage] ?? opp.stage}</Chip>
            {opp.source === "calendar" ? <Chip>Calendar</Chip> : null}
          </div>
          <p className="mt-1 text-xs text-[var(--color-fg-500)]">
            {opp.contact_email ?? "No contact"} · created {opp.created_at.slice(0, 10)}
          </p>
          {closed ? (
            <p className="mt-1 text-xs text-[var(--color-fg-300)]">{describeOutcome(opp)}</p>
          ) : null}
        </div>
        {!closed && !editing ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => setEditing({ id: opp.id, mode: "won" })}
            >
              Mark won
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setEditing({ id: opp.id, mode: "lost" })}
            >
              Mark lost
            </Button>
          </div>
        ) : null}
      </div>

      {editing ? (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit(editing.mode);
          }}
        >
          {editing.mode === "won" ? (
            <input
              type="number"
              min="0.01"
              step="0.01"
              required
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Deal value (CAD)"
              aria-label="Deal value in CAD"
              className="h-8 w-48 rounded-[var(--radius-md)] bg-[var(--color-bg-700)] px-2 text-sm text-[var(--color-fg-50)] ring-1 ring-inset ring-[var(--color-border-default)]"
            />
          ) : (
            <input
              type="text"
              required
              autoFocus
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why was it lost?"
              aria-label="Loss reason"
              className="h-8 w-72 rounded-[var(--radius-md)] bg-[var(--color-bg-700)] px-2 text-sm text-[var(--color-fg-50)] ring-1 ring-inset ring-[var(--color-border-default)]"
            />
          )}
          <Button
            type="submit"
            size="sm"
            variant={editing.mode === "won" ? "primary" : "danger"}
            disabled={pending}
          >
            {pending ? "Saving…" : editing.mode === "won" ? "Confirm won" : "Confirm lost"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setEditing(null)}
          >
            Cancel
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

export function PipelineList({ opportunities }: { opportunities: OpportunityRow[] }) {
  if (opportunities.length === 0) {
    return (
      <Card>
        <EmptyState
          className="min-h-[120px]"
          title="No opportunities yet"
          description="Booked meetings will appear here once they exist."
        />
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {opportunities.map((o) => (
        <OpportunityItem key={o.id} opp={o} />
      ))}
    </div>
  );
}
