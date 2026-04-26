"use client";

import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Filter,
  Loader2,
  Save,
  Send,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  savePitchEdit,
  transitionPitchStatus,
} from "@/lib/pitches/actions";
import type { PitchListRow, PitchStatus } from "@/lib/pitches/queries";
import { cn, relativeTime } from "@/lib/utils";

const STATUS_META: Record<
  PitchStatus,
  { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" }
> = {
  draft: { label: "Draft", tone: "neutral" },
  queued_for_approval: { label: "Queued", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  auto_rejected: { label: "Auto-rejected", tone: "danger" },
  reviewer_rejected: { label: "Rejected", tone: "danger" },
  sending: { label: "Sending…", tone: "info" },
  sent: { label: "Sent", tone: "success" },
  bounced: { label: "Bounced", tone: "danger" },
  failed: { label: "Failed", tone: "danger" },
};

const MARKET_FLAG: Record<"CA" | "MX" | "US" | "LATAM", string> = {
  CA: "🇨🇦",
  MX: "🇲🇽",
  US: "🇺🇸",
  LATAM: "🌎",
};

interface PitchesPageProps {
  pitches: PitchListRow[];
  counts: { total: number; draft: number; queued: number; approved: number; sent: number };
  canEdit: boolean;
}

type FilterValue = "ALL" | PitchStatus;

export function PitchesPage({ pitches, counts, canEdit }: PitchesPageProps) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<FilterValue>("draft");
  const [selectedId, setSelectedId] = React.useState<string | null>(
    pitches[0]?.id ?? null,
  );

  const visible = React.useMemo(
    () => (filter === "ALL" ? pitches : pitches.filter((p) => p.status === filter)),
    [pitches, filter],
  );

  const selected = React.useMemo(
    () => pitches.find((p) => p.id === selectedId) ?? null,
    [pitches, selectedId],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border-subtle)] px-4">
        <span className="font-mono text-xs text-[var(--color-fg-500)]">/pitches</span>
        <span className="text-[11px] text-[var(--color-fg-500)]">
          <span className="font-medium text-[var(--color-fg-50)]">{counts.total}</span> total ·{" "}
          <span className={counts.draft > 0 ? "font-medium text-[var(--color-fg-50)]" : ""}>
            {counts.draft} draft
          </span>{" "}
          ·{" "}
          <span className={counts.queued > 0 ? "font-medium text-[var(--color-warning-300)]" : ""}>
            {counts.queued} queued
          </span>{" "}
          · {counts.approved} approved · {counts.sent} sent
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-[var(--color-fg-700)]" aria-hidden />
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterValue)}
            className="h-8 max-w-[200px] py-0 text-xs"
          >
            <option value="ALL">All</option>
            <option value="draft">Draft (writing)</option>
            <option value="queued_for_approval">Queued for approval</option>
            <option value="approved">Approved</option>
            <option value="sent">Sent</option>
            <option value="reviewer_rejected">Rejected</option>
          </Select>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* List pane */}
        <div className="w-[420px] shrink-0 overflow-y-auto border-r border-[var(--color-border-subtle)]">
          {pitches.length === 0 ? (
            <EmptyState
              title="No pitches yet"
              description="From a prospect detail page, click 'Generate pitch' to create one."
            />
          ) : visible.length === 0 ? (
            <EmptyState
              title="No pitches match this filter"
              description="Switch to 'All' or another status."
            />
          ) : (
            <ul className="divide-y divide-[var(--color-border-subtle)]">
              {visible.map((p) => (
                <PitchRow
                  key={p.id}
                  pitch={p}
                  active={p.id === selectedId}
                  onClick={() => setSelectedId(p.id)}
                />
              ))}
            </ul>
          )}
        </div>

        {/* Detail pane */}
        <div className="flex-1 overflow-y-auto">
          {selected ? (
            <PitchDetail
              key={selected.id}
              pitch={selected}
              canEdit={canEdit}
              onChange={() => router.refresh()}
            />
          ) : (
            <div className="m-4 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-default)] bg-[var(--color-bg-900)] p-6 text-xs text-[var(--color-fg-500)]">
              Pick a pitch on the left to see + edit it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PitchRow({
  pitch,
  active,
  onClick,
}: {
  pitch: PitchListRow;
  active: boolean;
  onClick: () => void;
}) {
  const meta = STATUS_META[pitch.status];
  const score = pitch.quality_self_score ?? 0;
  const scoreColor =
    score >= 0.8
      ? "text-[var(--color-success-300)]"
      : score >= 0.5
        ? "text-[var(--color-info-300)]"
        : "text-[var(--color-warning-300)]";
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors",
          active ? "bg-[var(--color-bg-700)]" : "hover:bg-[var(--color-bg-800)]",
          "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-accent-300)]",
        )}
      >
        <div className="flex items-center gap-2">
          <Chip tone={meta.tone}>{meta.label}</Chip>
          {pitch.quality_self_score !== null ? (
            <span className={cn("font-mono text-[11px]", scoreColor)}>
              {Math.round(pitch.quality_self_score * 100)}%
            </span>
          ) : null}
          <span className="ml-auto text-[10px] text-[var(--color-fg-700)]">
            {relativeTime(pitch.updated_at)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {pitch.prospect_market ? (
            <span aria-hidden>{MARKET_FLAG[pitch.prospect_market]}</span>
          ) : null}
          <span className="truncate text-sm text-[var(--color-fg-50)]">
            {pitch.prospect_name ?? "(prospect missing)"}
          </span>
        </div>
        <div className="truncate text-[11px] text-[var(--color-fg-300)]">
          {pitch.subject}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[var(--color-fg-700)]">
          {pitch.case_study_client ? <span>↳ {pitch.case_study_client}</span> : null}
          {pitch.pain_label ? <span>· {pitch.pain_label}</span> : null}
        </div>
      </button>
    </li>
  );
}

function PitchDetail({
  pitch,
  canEdit,
  onChange,
}: {
  pitch: PitchListRow;
  canEdit: boolean;
  onChange: () => void;
}) {
  const meta = STATUS_META[pitch.status];
  const [subject, setSubject] = React.useState(pitch.subject);
  const [body, setBody] = React.useState("");
  const [bodyLoaded, setBodyLoaded] = React.useState(false);
  const [saving, startSave] = React.useTransition();
  const [transitioning, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [savedFlash, setSavedFlash] = React.useState(false);
  const [rejectReason, setRejectReason] = React.useState("");
  const [confirmingReject, setConfirmingReject] = React.useState(false);

  // Load body from server (we only loaded list rows in the parent).
  // The list row doesn't include body; fetch it via getPitch on demand.
  React.useEffect(() => {
    let cancelled = false;
    setBodyLoaded(false);
    fetch(`/api/pitches/${pitch.id}/body`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((d: { subject: string; body: string }) => {
        if (cancelled) return;
        setSubject(d.subject);
        setBody(d.body);
        setBodyLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        // Fall back to subject from list and an empty body — user can still
        // see the metadata.
        setSubject(pitch.subject);
        setBody("(failed to load body — refresh the page)");
        setBodyLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pitch.id, pitch.subject]);

  const wordCount = React.useMemo(
    () => body.trim().split(/\s+/).filter(Boolean).length,
    [body],
  );

  const handleSave = () => {
    setError(null);
    setSavedFlash(false);
    startSave(async () => {
      const res = await savePitchEdit({
        pitch_id: pitch.id,
        subject: subject.trim(),
        body_edited: body.trim(),
      });
      if (res.ok) {
        setSavedFlash(true);
        window.setTimeout(() => setSavedFlash(false), 2200);
        onChange();
      } else {
        setError(res.error);
      }
    });
  };

  const transition = (next: "queued_for_approval" | "approved" | "reviewer_rejected") => {
    setError(null);
    startTransition(async () => {
      const res = await transitionPitchStatus({
        pitch_id: pitch.id,
        next_status: next,
        rejection_reason: next === "reviewer_rejected" ? rejectReason || "no reason" : null,
      });
      if (res.ok) {
        setConfirmingReject(false);
        setRejectReason("");
        onChange();
      } else {
        setError(res.error);
      }
    });
  };

  const isLocked = pitch.status === "sent" || pitch.status === "sending";

  return (
    <div className="m-4 flex max-w-3xl flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 rounded-[var(--radius-lg)] bg-[var(--color-bg-800)] p-4 ring-1 ring-inset ring-[var(--color-border-default)]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Chip tone={meta.tone}>{meta.label}</Chip>
            {pitch.quality_self_score !== null ? (
              <span className="font-mono text-[11px] text-[var(--color-fg-500)]">
                self-score {Math.round(pitch.quality_self_score * 100)}%
              </span>
            ) : null}
            {pitch.prospect_language ? (
              <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-700)]">
                {pitch.prospect_language}
              </span>
            ) : null}
          </div>
          <Link
            href={`/companies/${pitch.prospect_id}` as never}
            className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-fg-50)] hover:text-[var(--color-accent-300)]"
          >
            {pitch.prospect_market ? (
              <span aria-hidden>{MARKET_FLAG[pitch.prospect_market]}</span>
            ) : null}
            {pitch.prospect_name ?? "(prospect missing)"}
            <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--color-fg-500)]">
            {pitch.case_study_client ? (
              <span>case: {pitch.case_study_client}</span>
            ) : null}
            {pitch.pain_label ? <span>· pain: {pitch.pain_label}</span> : null}
            {pitch.contact_email ? (
              <span>
                · to:{" "}
                <span className="font-mono text-[var(--color-fg-300)]">
                  {pitch.contact_email}
                </span>
                {pitch.contact_name ? ` (${pitch.contact_name})` : ""}
              </span>
            ) : (
              <span className="text-[var(--color-warning-300)]">
                · no contact email — pick one on the prospect page
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Editable subject + body */}
      <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] bg-[var(--color-bg-800)] p-4 ring-1 ring-inset ring-[var(--color-border-default)]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="subject">Subject</Label>
          <Input
            id="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={!canEdit || isLocked || !bodyLoaded}
            maxLength={300}
          />
          <p className="text-[10px] text-[var(--color-fg-700)]">
            {subject.length}/300 characters
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="body">Body</Label>
          <Textarea
            id="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            disabled={!canEdit || isLocked || !bodyLoaded}
            className="font-mono text-[12px] leading-relaxed"
          />
          <p className="text-[10px] text-[var(--color-fg-700)]">
            {wordCount} words · plain text · target ~140 words
          </p>
        </div>
      </div>

      {/* Action bar */}
      {canEdit && !isLocked ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-bg-800)] p-3 ring-1 ring-inset ring-[var(--color-border-default)]">
          {error ? (
            <p className="mr-auto max-w-md truncate text-[11px] text-[var(--color-danger-300)]">
              {error}
            </p>
          ) : savedFlash ? (
            <Chip tone="success" className="mr-auto">
              <CheckCircle2 className="h-3 w-3" aria-hidden /> Saved
            </Chip>
          ) : (
            <span className="mr-auto text-[11px] text-[var(--color-fg-700)]">
              Heuristic draft — review + edit before queuing.
            </span>
          )}
          <Button type="button" variant="secondary" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save edits
          </Button>
          {pitch.status === "draft" ? (
            <Button
              type="button"
              variant="primary"
              onClick={() => transition("queued_for_approval")}
              disabled={transitioning}
            >
              <Clock className="h-3.5 w-3.5" /> Queue for approval
            </Button>
          ) : null}
          {pitch.status === "queued_for_approval" ? (
            <>
              <Button
                type="button"
                variant="primary"
                onClick={() => transition("approved")}
                disabled={transitioning}
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> Approve
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfirmingReject((v) => !v)}
                disabled={transitioning}
              >
                <ShieldAlert className="h-3.5 w-3.5" /> Reject
              </Button>
            </>
          ) : null}
          {pitch.status === "approved" ? (
            <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--color-success-500),transparent_85%)] px-2 py-1 text-[11px] text-[var(--color-success-300)]">
              <CheckCircle2 className="h-3 w-3" /> Approved — Phase 4 will send
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Reject reason inline form */}
      {confirmingReject ? (
        <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-bg-900)] p-3 ring-1 ring-inset ring-[var(--color-danger-300)]">
          <Input
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Why? (e.g. tone is off, evidence quote misread)"
            className="flex-1"
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirmingReject(false)}
          >
            <X className="h-3.5 w-3.5" /> Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => transition("reviewer_rejected")}
            disabled={transitioning || !rejectReason.trim()}
          >
            Confirm reject
          </Button>
        </div>
      ) : null}

      {/* Sent / locked footer */}
      {isLocked ? (
        <div className="rounded-[var(--radius-lg)] bg-[var(--color-bg-900)] p-3 text-[11px] text-[var(--color-fg-500)] ring-1 ring-inset ring-[var(--color-border-default)]">
          <Send className="mr-1 inline-block h-3 w-3" aria-hidden /> This pitch is{" "}
          {pitch.status}; editing is locked.
          {pitch.sent_at ? ` Sent ${relativeTime(pitch.sent_at)}.` : ""}
        </div>
      ) : null}

      {/* Reasoning hint */}
      <details className="rounded-[var(--radius-md)] bg-[var(--color-bg-900)] p-3 text-[11px] text-[var(--color-fg-500)] ring-1 ring-inset ring-[var(--color-border-default)]">
        <summary className="cursor-pointer text-[var(--color-fg-300)]">
          <Sparkles className="mr-1 inline-block h-3 w-3" aria-hidden /> How was this composed?
        </summary>
        <p className="mt-2">
          Heuristic generator picks the first evidenced pain, scores case studies by
          industry match + pain strength, picks the best non-role-based contact, and
          slots into a {pitch.prospect_language === "es" ? "Spanish" : "English"} 5-line
          template. Phase 2 swaps in a Claude call returning the same shape — copy
          will improve, structure stays.
        </p>
      </details>
    </div>
  );
}
