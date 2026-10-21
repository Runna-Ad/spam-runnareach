"use client";

import { AlertTriangle, Check, ExternalLink, Pencil, X } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  rejectBenchmarkProposal,
  setBenchmarkActive,
  updateBenchmarkProposal,
} from "@/lib/benchmarks/actions";
import type { BenchmarkProposal, RejectedBenchmark } from "@/lib/benchmarks/proposals";

interface Props {
  proposals: BenchmarkProposal[];
  rejected: RejectedBenchmark[];
  canEdit: boolean;
}

/**
 * Each card holds everything needed to decide: the figure, the sentence it would be
 * quoted as, who published it, the link, the vendor flag, the caveat (always visible),
 * why research thinks it is solid, and which wanted fact asked for it. Cards come from
 * server props; an approved or rejected card leaves the list on the next refresh.
 */
export function ProposalReview({ proposals, rejected, canEdit }: Props) {
  const [msg, setMsg] = React.useState<string | null>(null);

  return (
    <section className="space-y-3" aria-labelledby="review-heading">
      {proposals.length > 0 ? (
        <>
        <div className="flex items-center justify-between gap-4">
          <h2 id="review-heading" className="text-base font-semibold text-[var(--color-fg-50)]">
            Waiting for your review ({proposals.length})
          </h2>
          {msg ? (
            <p role="status" className="text-xs text-[var(--color-warning-fg)]">
              {msg}
            </p>
          ) : null}
        </div>
        <p className="text-xs text-[var(--color-fg-500)]">
          Research found these for facts the writer asked for. Nothing here is quotable until you
          approve it.
        </p>
        <ul className="space-y-3">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} canEdit={canEdit} onMessage={setMsg} />
          ))}
        </ul>
        </>
      ) : null}
      {rejected.length > 0 ? (
        <details className="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
          <summary className="cursor-pointer text-xs text-[var(--color-fg-500)]">
            Rejected ({rejected.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {rejected.map((r) => (
              <li key={r.id} className="text-xs text-[var(--color-fg-500)]">
                <span className="text-[var(--color-fg-300)]">{r.figure}</span> · {r.statistic} ·{" "}
                {r.publisher} · rejected {r.rejected_at.slice(0, 10)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function ProposalCard({
  proposal: p,
  canEdit,
  onMessage,
}: {
  proposal: BenchmarkProposal;
  canEdit: boolean;
  onMessage: (m: string | null) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState({
    statistic: p.statistic,
    figure: p.figure,
    caveat: p.caveat ?? "",
    industries: p.industry_scope.join(", "),
    market: p.market ?? "",
    vendor: p.is_vendor_sourced,
  });

  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    onMessage(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) onMessage(res.error);
    });
  };

  const approve = () => run(() => setBenchmarkActive({ benchmark_id: p.id, is_active: true }));
  const reject = () => run(() => rejectBenchmarkProposal({ benchmark_id: p.id }));
  const saveAndApprove = () =>
    run(async () => {
      const saved = await updateBenchmarkProposal({
        benchmark_id: p.id,
        statistic: draft.statistic,
        figure: draft.figure,
        caveat: draft.caveat,
        industry_scope: draft.industries
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        market: draft.market,
        is_vendor_sourced: draft.vendor,
      });
      if (!saved.ok) return saved;
      return setBenchmarkActive({ benchmark_id: p.id, is_active: true });
    });

  const off = pending || !canEdit;

  return (
    <li className="rounded-[var(--radius-lg)] border border-[var(--color-border-default)] p-4">
      <div className="space-y-2">
        {editing ? (
          <div className="space-y-2">
            <label className="block text-xs text-[var(--color-fg-500)]">
              Figure
              <Input
                value={draft.figure}
                onChange={(e) => setDraft({ ...draft, figure: e.target.value })}
              />
            </label>
            <label className="block text-xs text-[var(--color-fg-500)]">
              Sentence it would be quoted as
              <Textarea
                rows={3}
                value={draft.statistic}
                onChange={(e) => setDraft({ ...draft, statistic: e.target.value })}
              />
            </label>
            <label className="block text-xs text-[var(--color-fg-500)]">
              Caveat
              <Textarea
                rows={3}
                value={draft.caveat}
                onChange={(e) => setDraft({ ...draft, caveat: e.target.value })}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs text-[var(--color-fg-500)]">
                Industries (comma separated)
                <Input
                  value={draft.industries}
                  onChange={(e) => setDraft({ ...draft, industries: e.target.value })}
                />
              </label>
              <label className="block text-xs text-[var(--color-fg-500)]">
                Market
                <Input
                  value={draft.market}
                  onChange={(e) => setDraft({ ...draft, market: e.target.value })}
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-xs text-[var(--color-fg-500)]">
              <input
                type="checkbox"
                checked={draft.vendor}
                onChange={(e) => setDraft({ ...draft, vendor: e.target.checked })}
              />
              Published by a vendor with a stake in the finding
            </label>
          </div>
        ) : (
          <>
            <p className="text-lg font-semibold text-[var(--color-fg-50)]">{p.figure}</p>
            <p className="text-sm text-[var(--color-fg-50)]">{p.statistic}</p>
          </>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {p.is_vendor_sourced ? <Chip tone="warning">Vendor-sourced</Chip> : null}
          {p.market ? <Chip tone="neutral">{p.market}</Chip> : null}
          {p.published_date ? <Chip tone="neutral">{p.published_date.slice(0, 4)}</Chip> : null}
        </div>

        <p className="text-xs text-[var(--color-fg-500)]">
          {p.publisher} ·{" "}
          <a
            href={p.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-[var(--color-fg-50)]"
          >
            source
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </p>

        {!editing && p.caveat ? (
          <div className="flex gap-2 rounded-[var(--radius-md)] bg-[var(--color-bg-raised)] p-2.5">
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning-fg)]"
              aria-hidden
            />
            <p className="text-xs leading-relaxed text-[var(--color-fg-500)]">{p.caveat}</p>
          </div>
        ) : null}

        {p.proposal_note ? (
          <p className="text-xs leading-relaxed text-[var(--color-fg-500)]">
            <span className="text-[var(--color-fg-700)]">Why research thinks it is solid:</span>{" "}
            {p.proposal_note}
          </p>
        ) : null}

        {p.wanted_fact ? (
          <p className="text-xs text-[var(--color-fg-500)]">
            <span className="text-[var(--color-fg-700)]">Asked for:</span> {p.wanted_fact.fact}{" "}
            (requested {p.wanted_fact.request_count}×)
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {editing ? (
          <>
            <Button type="button" size="sm" variant="primary" disabled={off} onClick={saveAndApprove}>
              <Check className="h-3.5 w-3.5" aria-hidden /> Save and approve
            </Button>
            <Button type="button" size="sm" disabled={pending} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button type="button" size="sm" variant="primary" disabled={off} onClick={approve}>
              <Check className="h-3.5 w-3.5" aria-hidden /> Approve
            </Button>
            <Button type="button" size="sm" disabled={off} onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit before approving
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={off} onClick={reject}>
              <X className="h-3.5 w-3.5" aria-hidden /> Reject
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
