"use client";

import { Plus } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { addWantedFact, setWantedFactStatus } from "@/lib/benchmarks/actions";
import type { PainOption, WantedFactRow, WantedFactStatus } from "@/lib/benchmarks/proposals";

interface Props {
  facts: WantedFactRow[];
  pains: PainOption[];
  canEdit: boolean;
}

const STATUS_LABEL: Record<WantedFactStatus, { text: string; tone: "neutral" | "success" | "warning" }> = {
  open: { text: "Waiting for research", tone: "neutral" },
  proposed: { text: "Proposal ready", tone: "success" },
  no_source: { text: "No solid source found", tone: "warning" },
  dismissed: { text: "Not looking", tone: "neutral" },
};

export function WantedFacts({ facts, pains, canEdit }: Props) {
  const [pending, startTransition] = React.useTransition();
  const [fact, setFact] = React.useState("");
  const [pain, setPain] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const painLabel = new Map(pains.map((p) => [p.code, p.label]));

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await addWantedFact({ fact, pain_code: pain || null });
      if (res.ok) {
        setFact("");
        setPain("");
      } else {
        setError(res.error);
      }
    });
  };

  const setStatus = (id: string, status: "dismissed" | "open") => {
    setError(null);
    startTransition(async () => {
      const res = await setWantedFactStatus({ wanted_fact_id: id, status });
      if (!res.ok) setError(res.error);
    });
  };

  return (
    <section className="space-y-3" aria-labelledby="wanted-heading">
      <h2 id="wanted-heading" className="text-base font-semibold text-[var(--color-fg-50)]">
        Facts the writer asked for
      </h2>
      <p className="text-xs text-[var(--color-fg-500)]">
        When the writer wants a statistic the library does not have, it lands here. Research looks
        for a source once a week. Add your own, or tell it not to look.
      </p>

      <form onSubmit={add} className="flex flex-wrap items-start gap-2">
        <Input
          className="min-w-64 flex-1"
          placeholder="e.g. share of small online stores with no abandoned-cart email"
          value={fact}
          onChange={(e) => setFact(e.target.value)}
          disabled={!canEdit || pending}
          aria-label="Fact to look for"
        />
        <div className="w-56">
          <Select
            value={pain}
            onChange={(e) => setPain(e.target.value)}
            disabled={!canEdit || pending}
            aria-label="Related pain"
          >
            <option value="">No specific pain</option>
            {pains.map((p) => (
              <option key={p.code} value={p.code}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="primary" disabled={!canEdit || pending || fact.trim() === ""}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-xs text-[var(--color-warning-fg)]">
          {error}
        </p>
      ) : null}

      {facts.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-500)]">Nothing requested yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border-subtle)] rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)]">
          {facts.map((f) => {
            const s = STATUS_LABEL[f.status];
            return (
              <li key={f.id} className="flex items-start justify-between gap-4 p-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm text-[var(--color-fg-50)]">{f.fact}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Chip tone={s.tone}>{s.text}</Chip>
                    <Chip tone="neutral">asked {f.request_count}×</Chip>
                    {f.pain_code ? (
                      <Chip tone="neutral">{painLabel.get(f.pain_code) ?? f.pain_code}</Chip>
                    ) : null}
                    {f.industry ? <Chip tone="neutral">{f.industry}</Chip> : null}
                  </div>
                  {f.research_note ? (
                    <p className="text-xs text-[var(--color-fg-500)]">{f.research_note}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  {f.status !== "dismissed" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={!canEdit || pending}
                      onClick={() => setStatus(f.id, "dismissed")}
                    >
                      Don&apos;t look for this
                    </Button>
                  ) : null}
                  {f.status === "dismissed" || f.status === "no_source" ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={!canEdit || pending}
                      onClick={() => setStatus(f.id, "open")}
                    >
                      Look again
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
