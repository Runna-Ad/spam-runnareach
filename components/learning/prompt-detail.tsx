"use client";

import { useState, useTransition } from "react";
import { PURPOSE_LABELS } from "@/lib/prompts/types";
import type { PromptDetail } from "@/lib/prompts/types";
import { rollbackVariant, runWeeklyAnalysis } from "@/lib/prompts/actions";
import { ProposalCard } from "./proposal-card";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { cn } from "@/lib/utils";

type Tab = "champion" | "history" | "proposals";

interface Props {
  detail: PromptDetail;
}

function formatDate(ts: string) {
  return new Date(ts).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="text-white/40 w-28 shrink-0">{label}</span>
      <span className="text-white/80">{value}</span>
    </div>
  );
}

function PromptBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold text-white/40 uppercase tracking-wide">{label}</p>
      <pre className="whitespace-pre-wrap font-mono text-xs text-white/70 leading-relaxed bg-white/[0.03] border border-white/10 rounded-lg p-4 overflow-auto max-h-72">
        {text}
      </pre>
    </div>
  );
}

function ChampionTab({ detail }: { detail: PromptDetail }) {
  const champion = detail.champion;

  if (!champion) {
    return (
      <div className="flex flex-col items-center gap-2 py-14 text-center">
        <p className="text-sm font-medium text-white/50">No champion set yet</p>
        <p className="max-w-xs text-xs text-white/30">
          Create a variant in the Proposals tab and promote it to champion to activate this prompt.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Metadata */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 flex flex-col gap-3">
        <MetaRow label="Version" value={<code className="text-accent-300">v{champion.version}</code>} />
        <MetaRow label="Model" value={champion.model} />
        <MetaRow
          label="Settings"
          value={`temp ${champion.temperature ?? "—"} · max_tokens ${champion.max_tokens ?? "—"}`}
        />
        <MetaRow
          label="Performance"
          value={`${champion.hit_count} uses · ${champion.reply_count} replies · ${champion.booked_count} booked`}
        />
        {champion.promoted_at && (
          <MetaRow label="Promoted" value={formatDate(champion.promoted_at)} />
        )}
      </div>

      {/* Prompts */}
      <PromptBlock label="System prompt" text={champion.system_prompt} />
      <PromptBlock label="User template" text={champion.user_prompt_template} />
    </div>
  );
}

function HistoryTab({ detail, onRollback }: { detail: PromptDetail; onRollback: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [rollingBack, setRollingBack] = useState<string | null>(null);

  const sorted = [...detail.variants].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  function handleRollback(variantId: string) {
    setRollingBack(variantId);
    startTransition(async () => {
      await rollbackVariant(variantId, detail.id);
      setRollingBack(null);
      onRollback();
    });
  }

  if (sorted.length === 0) {
    return (
      <p className="text-sm text-white/40 text-center py-12">No variant history yet.</p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {sorted.map((v) => (
        <div
          key={v.id}
          className="rounded-xl border border-white/10 bg-white/[0.03] p-4 flex items-center justify-between gap-4"
        >
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <code className="text-sm text-white/80">v{v.version}</code>
              <Chip
                tone={
                  v.status === "champion"
                    ? "success"
                    : v.status === "challenger"
                      ? "info"
                      : v.status === "retired"
                        ? "neutral"
                        : "warning"
                }
              >
                {v.status}
              </Chip>
              {v.status === "challenger" && v.challenger_traffic_pct != null && v.challenger_traffic_pct > 0 && (
                <Chip tone="info">{v.challenger_traffic_pct}% traffic</Chip>
              )}
            </div>
            <p className="text-xs text-white/40">
              {v.model} · created {formatDate(v.created_at)}
              {v.promoted_at ? ` · promoted ${formatDate(v.promoted_at)}` : ""}
              {v.retired_at ? ` · retired ${formatDate(v.retired_at)}` : ""}
            </p>
            <p className="text-xs text-white/30">
              {v.hit_count} uses · {v.reply_count} replies
            </p>
          </div>
          {v.status === "retired" && (
            <Button
              size="sm"
              variant="secondary"
              disabled={isPending}
              onClick={() => handleRollback(v.id)}
            >
              {rollingBack === v.id ? "Rolling back…" : "↩ Rollback"}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function ProposalsTab({
  detail,
  onAnalysisRun,
}: {
  detail: PromptDetail;
  onAnalysisRun: (msg: string) => void;
}) {
  const [isAnalyzing, startTransition] = useTransition();

  function handleRunAnalysis() {
    startTransition(async () => {
      const res = await runWeeklyAnalysis(detail.id);
      onAnalysisRun(res.error ?? "Analysis started.");
    });
  }

  const pending = detail.proposals.filter((p) =>
    ["pending", "ab_testing"].includes(p.status),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-white/50">
          {pending.length === 0
            ? "No proposals pending."
            : `${pending.length} proposal${pending.length > 1 ? "s" : ""} awaiting review.`}
        </p>
        <Button size="sm" variant="secondary" disabled={isAnalyzing} onClick={handleRunAnalysis}>
          {isAnalyzing ? "Running…" : "⚡ Run analysis now"}
        </Button>
      </div>

      {pending.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-8 text-center flex flex-col gap-2">
          <p className="text-3xl">📋</p>
          <p className="text-sm font-medium text-white/60">No pending proposals</p>
          <p className="text-xs text-white/30 max-w-xs mx-auto">
            Claude runs the learning analysis every Sunday and proposes prompt tweaks
            backed by 4-week performance data. Approve, A/B test, or reject each one.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {pending.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </div>
      )}
    </div>
  );
}

export function PromptDetailPanel({ detail }: Props) {
  const [tab, setTab] = useState<Tab>("champion");
  const [toast, setToast] = useState<string | null>(null);

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "champion", label: "Champion" },
    { id: "history", label: "History", badge: detail.variants.length },
    {
      id: "proposals",
      label: "Proposals",
      badge: detail.proposals.filter((p) => p.status === "pending").length || undefined,
    },
  ];

  return (
    <div className="flex flex-col gap-6 h-full">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-white">
            {PURPOSE_LABELS[detail.purpose]}
          </h2>
          {!detail.is_active && <Chip tone="neutral">inactive</Chip>}
        </div>
        {detail.description && (
          <p className="text-sm text-white/40">{detail.description}</p>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-300">
          {toast}
          <button
            className="ml-3 text-amber-500 hover:text-amber-300"
            onClick={() => setToast(null)}
          >
            ✕
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-white/10 pb-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              tab === t.id
                ? "border-[var(--color-accent-300)] text-white"
                : "border-transparent text-white/40 hover:text-white/70",
            )}
          >
            {t.label}
            {t.badge != null && t.badge > 0 && (
              <span
                className={cn(
                  "flex items-center justify-center rounded-full text-[10px] font-semibold w-4 h-4",
                  t.id === "proposals"
                    ? "bg-amber-500/20 text-amber-400"
                    : "bg-white/10 text-white/50",
                )}
              >
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto pr-1">
        {tab === "champion" && <ChampionTab detail={detail} />}
        {tab === "history" && (
          <HistoryTab detail={detail} onRollback={() => setToast("Rollback applied.")} />
        )}
        {tab === "proposals" && (
          <ProposalsTab detail={detail} onAnalysisRun={(msg) => setToast(msg)} />
        )}
      </div>
    </div>
  );
}
