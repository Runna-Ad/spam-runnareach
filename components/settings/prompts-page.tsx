"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  FlaskConical,
  RotateCcw,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import {
  fetchPromptDetail,
  reviewProposal,
  rollbackVariant,
} from "@/lib/prompts/actions";
import {
  PURPOSE_GROUPS,
  PURPOSE_LABELS,
  type PromptDetail,
  type PromptVariant,
  type PromptWithChampion,
} from "@/lib/prompts/types";

// ─── helpers ────────────────────────────────────────────────────────────────

function fmt(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function VariantStatusChip({ status }: { status: PromptVariant["status"] }) {
  if (status === "champion")
    return (
      <Chip tone="success">
        <Sparkles size={10} />
        Champion
      </Chip>
    );
  if (status === "challenger")
    return (
      <Chip tone="warning">
        <FlaskConical size={10} />
        Challenger
      </Chip>
    );
  if (status === "candidate")
    return (
      <Chip tone="accent">
        <Clock size={10} />
        Candidate
      </Chip>
    );
  return <Chip tone="neutral">Retired</Chip>;
}

// ─── sidebar row ────────────────────────────────────────────────────────────

function SidebarRow({
  prompt,
  selected,
  onSelect,
}: {
  prompt: PromptWithChampion;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "w-full flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-left",
        "transition-colors duration-[var(--duration-standard)]",
        selected
          ? "bg-[color-mix(in_oklab,var(--color-accent-300),transparent_85%)] text-[var(--color-fg-50)]"
          : "text-[var(--color-fg-300)] hover:bg-[var(--color-bg-700)] hover:text-[var(--color-fg-50)]",
      ].join(" ")}
    >
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-medium truncate">
          {PURPOSE_LABELS[prompt.purpose]}
        </span>
        <span className="flex items-center gap-1 mt-0.5 flex-wrap">
          {prompt.language === "es" && (
            <Chip tone="info" className="text-[10px]">
              ES
            </Chip>
          )}
          {prompt.champion ? (
            <Chip tone="success" className="text-[10px]">
              Live
            </Chip>
          ) : (
            <Chip tone="neutral" className="text-[10px]">
              No prompt
            </Chip>
          )}
          {prompt.pending_proposals > 0 && (
            <Chip tone="warning" className="text-[10px]">
              {prompt.pending_proposals} pending
            </Chip>
          )}
        </span>
      </span>
      <ChevronRight
        size={12}
        className={selected ? "text-[var(--color-accent-300)]" : "text-[var(--color-fg-500)]"}
      />
    </button>
  );
}

// ─── detail panel ───────────────────────────────────────────────────────────

function DetailPanel({
  promptId,
  promptSummary,
}: {
  promptId: string;
  promptSummary: PromptWithChampion;
}) {
  const [detail, setDetail] = React.useState<PromptDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);

  React.useEffect(() => {
    setLoading(true);
    setDetail(null);
    setHistoryOpen(false);
    fetchPromptDetail(promptId).then((d) => {
      setDetail(d);
      setLoading(false);
    });
  }, [promptId]);

  async function handleReview(
    proposalId: string,
    action: "approve" | "reject" | "start_ab",
  ) {
    setPendingAction(`${proposalId}:${action}`);
    try {
      await reviewProposal(proposalId, action);
      const refreshed = await fetchPromptDetail(promptId);
      setDetail(refreshed);
    } finally {
      setPendingAction(null);
    }
  }

  async function handleRollback(variantId: string) {
    setPendingAction(`rollback:${variantId}`);
    try {
      await rollbackVariant(variantId, promptId);
      const refreshed = await fetchPromptDetail(promptId);
      setDetail(refreshed);
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="flex flex-col gap-4 min-w-0">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
          {PURPOSE_LABELS[promptSummary.purpose]}
        </h2>
        {promptSummary.language === "es" && <Chip tone="info">ES</Chip>}
        {promptSummary.is_active ? (
          <Chip tone="success">Active</Chip>
        ) : (
          <Chip tone="neutral">Inactive</Chip>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-[var(--color-fg-500)] py-8">
          <Clock size={14} className="animate-spin" />
          Loading…
        </div>
      )}

      {!loading && detail && (
        <>
          {/* Champion section */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Sparkles size={13} className="text-[var(--color-success-300)]" />
                Champion
              </CardTitle>
            </CardHeader>
            <CardContent>
              {detail.champion ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-xs text-[var(--color-fg-500)]">
                    <span>v{detail.champion.version}</span>
                    <span>·</span>
                    <span>Promoted {fmt(detail.champion.promoted_at)}</span>
                    <span>·</span>
                    <span>{detail.champion.hit_count} hits</span>
                  </div>
                  <pre className="bg-[var(--color-bg-900)] rounded-[var(--radius-md)] p-3 text-xs text-[var(--color-fg-200)] font-mono overflow-auto max-h-64 whitespace-pre-wrap break-words ring-1 ring-inset ring-[var(--color-border-subtle)]">
                    {detail.champion.system_prompt}
                  </pre>
                  {detail.champion.user_prompt_template && (
                    <>
                      <p className="text-xs text-[var(--color-fg-500)] mt-1">User template</p>
                      <pre className="bg-[var(--color-bg-900)] rounded-[var(--radius-md)] p-3 text-xs text-[var(--color-fg-200)] font-mono overflow-auto max-h-48 whitespace-pre-wrap break-words ring-1 ring-inset ring-[var(--color-border-subtle)]">
                        {detail.champion.user_prompt_template}
                      </pre>
                    </>
                  )}
                </div>
              ) : (
                <EmptyState
                  icon={<Sparkles size={24} />}
                  title="No champion yet"
                  description="Approve a proposal below to promote the first champion."
                  className="min-h-[120px] py-6"
                />
              )}
            </CardContent>
          </Card>

          {/* Pending proposals */}
          {detail.proposals.filter((p) => p.status === "pending").length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <AlertTriangle size={13} className="text-[var(--color-warning-300)]" />
                  Pending Proposals
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-4">
                  {detail.proposals
                    .filter((p) => p.status === "pending")
                    .map((proposal) => {
                      const body =
                        proposal.proposed_variant?.system_prompt ?? "";
                      const truncated =
                        body.length > 200 ? body.slice(0, 200) + "…" : body;
                      return (
                        <div
                          key={proposal.id}
                          className="flex flex-col gap-2 pb-4 border-b border-[var(--color-border-subtle)] last:border-0 last:pb-0"
                        >
                          <div className="flex items-center gap-2 text-xs text-[var(--color-fg-500)]">
                            <Clock size={11} />
                            <span>Proposed {fmt(proposal.proposed_at)}</span>
                            {proposal.expected_impact && (
                              <>
                                <span>·</span>
                                <span className="text-[var(--color-fg-300)]">
                                  {proposal.expected_impact}
                                </span>
                              </>
                            )}
                          </div>
                          {proposal.reasoning && (
                            <p className="text-xs text-[var(--color-fg-400)] italic">
                              {proposal.reasoning}
                            </p>
                          )}
                          <pre className="bg-[var(--color-bg-900)] rounded-[var(--radius-md)] p-3 text-xs text-[var(--color-fg-200)] font-mono overflow-hidden ring-1 ring-inset ring-[var(--color-border-subtle)] whitespace-pre-wrap break-words">
                            {truncated}
                          </pre>
                          <div className="flex items-center gap-2 flex-wrap">
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={pendingAction !== null}
                              onClick={() => handleReview(proposal.id, "approve")}
                            >
                              <CheckCircle2 size={13} />
                              {pendingAction === `${proposal.id}:approve`
                                ? "Approving…"
                                : "Approve"}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={pendingAction !== null}
                              onClick={() =>
                                handleReview(proposal.id, "start_ab")
                              }
                            >
                              <FlaskConical size={13} />
                              {pendingAction === `${proposal.id}:start_ab`
                                ? "Starting…"
                                : "Start A/B"}
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={pendingAction !== null}
                              onClick={() =>
                                handleReview(proposal.id, "reject")
                              }
                            >
                              <XCircle size={13} />
                              {pendingAction === `${proposal.id}:reject`
                                ? "Rejecting…"
                                : "Reject"}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Version history (collapsed) */}
          <Card>
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 text-left"
              onClick={() => setHistoryOpen((o) => !o)}
            >
              <span className="text-xs font-medium text-[var(--color-fg-300)] flex items-center gap-1.5">
                <Clock size={12} />
                Version History ({detail.variants.length})
              </span>
              <ChevronRight
                size={13}
                className={[
                  "text-[var(--color-fg-500)] transition-transform duration-150",
                  historyOpen ? "rotate-90" : "",
                ].join(" ")}
              />
            </button>
            {historyOpen && (
              <CardContent className="pt-0">
                <div className="flex flex-col gap-1">
                  {[...detail.variants]
                    .sort(
                      (a, b) =>
                        new Date(b.created_at).getTime() -
                        new Date(a.created_at).getTime(),
                    )
                    .map((v) => (
                      <div
                        key={v.id}
                        className="flex items-center gap-2 py-1.5 border-b border-[var(--color-border-subtle)] last:border-0"
                      >
                        <VariantStatusChip status={v.status} />
                        <span className="text-xs text-[var(--color-fg-300)] flex-1">
                          v{v.version}
                        </span>
                        <span className="text-xs text-[var(--color-fg-500)]">
                          {fmt(v.created_at)}
                        </span>
                        {v.status !== "champion" && v.status !== "retired" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pendingAction !== null}
                            onClick={() => handleRollback(v.id)}
                            title="Rollback to this version"
                          >
                            <RotateCcw size={12} />
                            {pendingAction === `rollback:${v.id}`
                              ? "Rolling back…"
                              : "Rollback"}
                          </Button>
                        )}
                      </div>
                    ))}
                </div>
              </CardContent>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ─── main export ────────────────────────────────────────────────────────────

export function PromptsPage({ prompts }: { prompts: PromptWithChampion[] }) {
  const firstId = prompts[0]?.id ?? null;
  const [selectedId, setSelectedId] = React.useState<string | null>(firstId);

  const selectedPrompt = prompts.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0 gap-0">
      {/* Sidebar */}
      <aside className="w-[280px] shrink-0 flex flex-col border-r border-[var(--color-border-default)] overflow-y-auto">
        <div className="px-3 py-3 border-b border-[var(--color-border-subtle)]">
          <h1 className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
            Prompts
          </h1>
          <p className="text-xs text-[var(--color-fg-500)] mt-0.5">
            {prompts.length} prompts across {PURPOSE_GROUPS.length} groups
          </p>
        </div>
        <nav className="flex flex-col gap-3 p-3">
          {PURPOSE_GROUPS.map((group) => {
            const groupPrompts = group.purposes
              .map((p) => prompts.find((pr) => pr.purpose === p))
              .filter((p): p is PromptWithChampion => p !== undefined);

            if (groupPrompts.length === 0) return null;

            return (
              <div key={group.label}>
                <p className="px-1 mb-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--color-fg-500)]">
                  {group.label}
                </p>
                <div className="flex flex-col gap-0.5">
                  {groupPrompts.map((prompt) => (
                    <SidebarRow
                      key={prompt.id}
                      prompt={prompt}
                      selected={selectedId === prompt.id}
                      onSelect={() => setSelectedId(prompt.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
      </aside>

      {/* Detail */}
      <main className="flex-1 min-w-0 overflow-y-auto p-6">
        {selectedPrompt ? (
          <DetailPanel
            key={selectedPrompt.id}
            promptId={selectedPrompt.id}
            promptSummary={selectedPrompt}
          />
        ) : (
          <EmptyState
            icon={<Sparkles size={28} />}
            title="No prompts found"
            description="Prompts will appear here once the pipeline is initialized."
          />
        )}
      </main>
    </div>
  );
}
