"use client";

import type { Route } from "next";

import {
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Trash2,
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
  bulkApprovePitches,
  savePitchEdit,
  transitionPitchStatus,
} from "@/lib/pitches/actions";
import { bulkDeleteProspects } from "@/lib/discover/bulk-actions";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { sendPitch, queueApprovedForSend } from "@/lib/pitches/send-action";
import { PitchAngleAdvisor } from "@/components/pitches/pitch-angle-advisor";
import type { PitchListRow, PitchStatus } from "@/lib/pitches/queries";
import type { SenderInbox } from "@/lib/settings/sending-queries";
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
  counts: { total: number; draft: number; queued: number; approved: number; queuedForSend: number; sent: number };
  canEdit: boolean;
  inboxes: SenderInbox[];
}

// "queued_for_send" is a DERIVED view (status 'approved' + scheduled_send_at set),
// not a real status — handled specially in the filter below.
type FilterValue = "ALL" | PitchStatus | "queued_for_send";

/** A pitch is queued into the drip-send queue when it's approved AND scheduled. */
function isQueuedForSend(p: PitchListRow): boolean {
  return p.status === "approved" && !!p.scheduled_send_at;
}

/** Display chip — surfaces "Queued to send" instead of plain "Approved" once scheduled. */
function pitchMeta(p: PitchListRow): { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" } {
  if (isQueuedForSend(p)) return { label: "Queued to send", tone: "info" };
  return STATUS_META[p.status];
}

export function PitchesPage({ pitches, counts, canEdit, inboxes }: PitchesPageProps) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<FilterValue>("draft");
  const [selectedId, setSelectedId] = React.useState<string | null>(
    pitches[0]?.id ?? null,
  );
  // Multi-select for bulk approve (separate from the detail selection).
  const [checked, setChecked] = React.useState<Set<string>>(new Set());
  const [approving, startApprove] = React.useTransition();
  React.useEffect(() => setChecked(new Set()), [filter]);

  const [deleting, startDelete] = React.useTransition();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = React.useState(false);

  const toggleCheck = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const visible = React.useMemo(() => {
    if (filter === "ALL") return pitches;
    if (filter === "queued_for_send") return pitches.filter(isQueuedForSend);
    // "Approved" means ready-to-queue only — queued ones live in their own view.
    if (filter === "approved") return pitches.filter((p) => p.status === "approved" && !p.scheduled_send_at);
    return pitches.filter((p) => p.status === filter);
  }, [pitches, filter]);

  const selected = React.useMemo(
    () => pitches.find((p) => p.id === selectedId) ?? null,
    [pitches, selectedId],
  );

  // Default send-from inbox for bulk queueing: first connected, non-paused one.
  const sendInbox = React.useMemo(
    () => inboxes.find((i) => i.gmail_connected && !i.paused) ?? null,
    [inboxes],
  );
  const [queuing, startQueue] = React.useTransition();
  const [queueMsg, setQueueMsg] = React.useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const handleQueueAll = () => {
    if (!sendInbox) return;
    setQueueMsg(null);
    startQueue(async () => {
      const res = await queueApprovedForSend({ inbox_id: sendInbox.id });
      if (res.ok) {
        setQueueMsg({
          tone: res.queued > 0 ? "ok" : "warn",
          text:
            res.queued > 0
              ? `Queued ${res.queued} pitch${res.queued === 1 ? "" : "es"} — drips out ~6/day from ${sendInbox.email}`
              : "No approved pitches with a contact to queue.",
        });
        router.refresh();
      } else {
        setQueueMsg({ tone: "warn", text: res.error });
      }
      window.setTimeout(() => setQueueMsg(null), 7000);
    });
  };

  const isApprovable = (p: PitchListRow) =>
    p.status === "draft" || p.status === "queued_for_approval";
  // Every visible pitch is selectable (so you can DELETE any, not just approvable).
  const allChecked = visible.length > 0 && visible.every((p) => checked.has(p.id));
  const approvableCheckedCount = visible.filter(
    (p) => checked.has(p.id) && isApprovable(p),
  ).length;
  const toggleAll = () =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (visible.every((p) => prev.has(p.id))) {
        visible.forEach((p) => next.delete(p.id));
      } else {
        visible.forEach((p) => next.add(p.id));
      }
      return next;
    });

  // Delete = remove the underlying PROSPECT (and cascade its pitches/research/
  // contacts) — used when a prospect isn't worth pursuing (e.g. a fake/placeholder
  // contact slipped through). Maps the selected pitches to their prospects.
  const checkedProspectIds = React.useMemo(
    () =>
      Array.from(
        new Set(
          pitches
            .filter((p) => checked.has(p.id) && p.prospect_id)
            .map((p) => p.prospect_id as string),
        ),
      ),
    [pitches, checked],
  );

  const handleBulkDelete = () => {
    if (checkedProspectIds.length === 0) return;
    startDelete(async () => {
      const res = await bulkDeleteProspects({ prospect_ids: checkedProspectIds });
      setConfirmDeleteOpen(false);
      if (res.ok) {
        setQueueMsg({
          tone: "ok",
          text: `Deleted ${res.affected} prospect${res.affected === 1 ? "" : "s"} and their pitches.`,
        });
        setChecked(new Set());
        router.refresh();
      } else {
        setQueueMsg({ tone: "warn", text: res.error });
      }
      window.setTimeout(() => setQueueMsg(null), 7000);
    });
  };

  const handleBulkApprove = () => {
    if (checked.size === 0) return;
    startApprove(async () => {
      const res = await bulkApprovePitches({ pitch_ids: [...checked] });
      if (res.ok) {
        // Say plainly when some were held back — silently approving fewer than
        // the user selected is how unsendable drafts went unnoticed.
        const skipped =
          res.skipped_no_contact > 0
            ? ` ${res.skipped_no_contact} skipped — no contact email.`
            : "";
        setQueueMsg({
          tone: res.approved > 0 ? "ok" : "warn",
          text:
            res.approved > 0
              ? `Approved ${res.approved} pitch${res.approved === 1 ? "" : "es"} — ready to queue for send.${skipped}`
              : skipped
                ? `Nothing approved.${skipped}`
                : "Nothing approvable in the selection.",
        });
        setChecked(new Set());
        router.refresh();
      } else {
        setQueueMsg({ tone: "warn", text: res.error });
      }
      window.setTimeout(() => setQueueMsg(null), 7000);
    });
  };

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
          · {counts.approved} approved
          {counts.queuedForSend > 0 ? (
            <>
              {" "}·{" "}
              <span className="font-medium text-[var(--color-info-300)]">
                {counts.queuedForSend} queued to send
              </span>
            </>
          ) : null}{" "}
          · {counts.sent} sent
        </span>
        <div className="ml-auto flex items-center gap-2">
          {queueMsg ? (
            <span
              className={cn(
                "rounded-[var(--radius-sm)] px-2 py-1 text-[11px]",
                queueMsg.tone === "ok"
                  ? "bg-[color-mix(in_oklab,var(--color-success-500),transparent_85%)] text-[var(--color-success-300)]"
                  : "bg-[color-mix(in_oklab,var(--color-warning-500),transparent_85%)] text-[var(--color-warning-300)]",
              )}
            >
              {queueMsg.text}
            </span>
          ) : null}
          {canEdit && counts.approved > 0 && sendInbox ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={handleQueueAll}
              disabled={queuing}
              title={`Queue the ${counts.approved} approved (not-yet-queued) pitches to drip-send from ${sendInbox.email}`}
            >
              {queuing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Send className="h-3.5 w-3.5" aria-hidden />
              )}
              Queue {counts.approved} for send
            </Button>
          ) : null}
          <Filter className="h-3.5 w-3.5 text-[var(--color-fg-700)]" aria-hidden />
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterValue)}
            className="h-8 max-w-[200px] py-0 text-xs"
          >
            <option value="ALL">All</option>
            <option value="draft">Draft (writing)</option>
            <option value="queued_for_approval">Queued for approval</option>
            <option value="approved">Approved (ready to queue)</option>
            <option value="queued_for_send">Queued to send</option>
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
              icon={<Sparkles className="h-8 w-8 opacity-40" />}
              title="No pitches yet"
              description="Open a prospect from Companies, then click 'Generate pitch' to create your first one."
              action={
                <Link href="/companies">
                  <Button variant="secondary" size="sm">
                    Go to Companies
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden />
                  </Button>
                </Link>
              }
            />
          ) : visible.length === 0 ? (
            <EmptyState
              title="No pitches match this filter"
              description="Switch to 'All' or another status."
            />
          ) : (
            <>
              {canEdit && visible.length > 0 ? (
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-900)] px-3 py-2">
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--color-fg-500)]">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={(el) => {
                        if (el) el.indeterminate = checked.size > 0 && !allChecked;
                      }}
                      onChange={toggleAll}
                      aria-label="Select all pitches"
                      className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-accent-300)]"
                    />
                    {checked.size > 0 ? `${checked.size} selected` : "Select all"}
                  </label>
                  {checked.size > 0 ? (
                    <div className="ml-auto flex items-center gap-1.5">
                      {approvableCheckedCount > 0 ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="primary"
                          onClick={handleBulkApprove}
                          disabled={approving || deleting}
                        >
                          {approving ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Check className="h-3.5 w-3.5" aria-hidden />
                          )}
                          Approve {approvableCheckedCount}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        onClick={() => setConfirmDeleteOpen(true)}
                        disabled={deleting || approving || checkedProspectIds.length === 0}
                      >
                        {deleting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        )}
                        Delete {checkedProspectIds.length}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <ul className="divide-y divide-[var(--color-border-subtle)]">
                {visible.map((p) => (
                  <PitchRow
                    key={p.id}
                    pitch={p}
                    active={p.id === selectedId}
                    onClick={() => setSelectedId(p.id)}
                    checkable={canEdit}
                    checked={checked.has(p.id)}
                    onToggleCheck={() => toggleCheck(p.id)}
                  />
                ))}
              </ul>
            </>
          )}
        </div>

        {/* Detail pane */}
        <div className="flex-1 overflow-y-auto">
          {selected ? (
            <PitchDetail
              key={selected.id}
              pitch={selected}
              canEdit={canEdit}
              inboxes={inboxes}
              onChange={() => router.refresh()}
            />
          ) : (
            <div className="m-4 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-default)] bg-[var(--color-bg-900)] p-6 text-xs text-[var(--color-fg-500)]">
              Pick a pitch on the left to see + edit it.
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={`Delete ${checkedProspectIds.length} prospect${checkedProspectIds.length === 1 ? "" : "s"}?`}
        description="This permanently removes the selected pitches' prospects and all their research, scores, pitches, and contacts. This can't be undone. Prospects with a booked opportunity are skipped automatically."
        confirmLabel={`Delete ${checkedProspectIds.length}`}
        variant="danger"
        pending={deleting}
        onConfirm={handleBulkDelete}
      />
    </div>
  );
}

function PitchRow({
  pitch,
  active,
  onClick,
  checkable,
  checked,
  onToggleCheck,
}: {
  pitch: PitchListRow;
  active: boolean;
  onClick: () => void;
  checkable: boolean;
  checked: boolean;
  onToggleCheck: () => void;
}) {
  const meta = pitchMeta(pitch);
  const score = pitch.quality_self_score ?? 0;
  const scoreColor =
    score >= 0.8
      ? "text-[var(--color-success-300)]"
      : score >= 0.5
        ? "text-[var(--color-info-300)]"
        : "text-[var(--color-warning-300)]";
  return (
    <li className="flex items-stretch">
      {checkable ? (
        <label
          className="flex cursor-pointer items-center pl-3"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggleCheck}
            aria-label={checked ? "Deselect pitch" : "Select pitch"}
            className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-accent-300)]"
          />
        </label>
      ) : (
        <span className="w-3.5 pl-3" aria-hidden />
      )}
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
  inboxes,
  onChange,
}: {
  pitch: PitchListRow;
  canEdit: boolean;
  inboxes: SenderInbox[];
  onChange: () => void;
}) {
  const meta = pitchMeta(pitch);
  const [subject, setSubject] = React.useState(pitch.subject);
  const [body, setBody] = React.useState("");
  const [bodyLoaded, setBodyLoaded] = React.useState(false);
  // Bumped after an angle rewrite to force the body/subject to re-fetch.
  const [reloadKey, setReloadKey] = React.useState(0);
  const [saving, startSave] = React.useTransition();
  const [transitioning, startTransition] = React.useTransition();
  const [sending, startSending] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [savedFlash, setSavedFlash] = React.useState(false);
  const [rejectReason, setRejectReason] = React.useState("");
  const [rejectKind, setRejectKind] = React.useState<
    "wrong_case" | "wrong_pain" | "tone_off" | "wrong_contact" | "other"
  >("wrong_case");
  const [confirmingReject, setConfirmingReject] = React.useState(false);

  // Inbox selector for the Send panel
  const connectedInboxes = inboxes.filter((i) => i.gmail_connected && !i.paused);
  const [selectedInboxId, setSelectedInboxId] = React.useState<string>(
    connectedInboxes[0]?.id ?? "",
  );

  const handleSend = () => {
    if (!selectedInboxId) return;
    setError(null);
    startSending(async () => {
      const res = await sendPitch({ pitch_id: pitch.id, inbox_id: selectedInboxId });
      if (res.ok) {
        onChange();
      } else {
        setError(res.error);
      }
    });
  };

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
  }, [pitch.id, pitch.subject, reloadKey]);

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
        rejection_reason_kind: next === "reviewer_rejected" ? rejectKind : undefined,
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
            href={`/companies/${pitch.prospect_id}` as Route}
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
                {/* An unverified firstname@domain guess kept only because the
                    domain is catch-all. Flagged so a guess is never approved
                    in the belief it's a confirmed address. */}
                {pitch.contact_is_guess ? (
                  <span
                    className="ml-1.5 rounded-sm border border-[var(--color-warning-300)]/40 px-1 py-px font-medium text-[var(--color-warning-300)]"
                    title="Unverified guess: no confirmed address was found, so this is firstname@domain on a catch-all mail server. It won't bounce, but it may not reach anyone."
                  >
                    guessed address
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-[var(--color-warning-300)]">
                · no contact email — pick one on the prospect page
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Pitch angle advisor — suggests angles + can rewrite this pitch with one */}
      <PitchAngleAdvisor
        prospectId={pitch.prospect_id}
        pitchId={pitch.id}
        onApplied={() => {
          setReloadKey((k) => k + 1);
          onChange();
        }}
        compact
      />

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

        {/* Email preview — shows how the CTA renders as a button in the HTML email */}
        {body.includes("👉") && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg-700)]">
              Email preview
            </span>
            <div className="rounded-[var(--radius-md)] bg-white p-4 text-[13px] leading-relaxed text-[#1a1a1a] ring-1 ring-inset ring-[var(--color-border-default)]">
              <EmailBodyPreview body={body} lang={pitch.prospect_language} />
            </div>
          </div>
        )}
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
            connectedInboxes.length === 0 ? (
              <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--color-warning-500),transparent_85%)] px-2 py-1 text-[11px] text-[var(--color-warning-300)]">
                <CheckCircle2 className="h-3 w-3" /> Approved — connect a Gmail inbox in Settings → Sending to send
              </span>
            ) : (
              <div className="flex items-center gap-2">
                <Select
                  value={selectedInboxId}
                  onChange={(e) => setSelectedInboxId(e.target.value)}
                  className="h-8 max-w-[220px] py-0 text-xs"
                  aria-label="Sender inbox"
                >
                  {connectedInboxes.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.email} ({i.sends_today}/{i.daily_cap})
                    </option>
                  ))}
                </Select>
                <Button
                  type="button"
                  variant="primary"
                  onClick={handleSend}
                  disabled={sending || !selectedInboxId}
                >
                  {sending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Send className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {sending ? "Sending…" : "Send now"}
                </Button>
              </div>
            )
          ) : null}
        </div>
      ) : null}

      {/* Reject reason inline form. The "kind" dropdown drives the
          generator's downrank: rejected pairs get penalized so the next
          pitch picks differently. */}
      {confirmingReject ? (
        <div className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-[var(--color-bg-900)] p-3 ring-1 ring-inset ring-[var(--color-danger-300)]">
          <div className="flex items-center gap-2">
            <Select
              value={rejectKind}
              onChange={(e) =>
                setRejectKind(
                  e.target.value as
                    | "wrong_case"
                    | "wrong_pain"
                    | "tone_off"
                    | "wrong_contact"
                    | "other",
                )
              }
              className="max-w-[180px] py-0 text-xs"
            >
              <option value="wrong_case">Wrong case study</option>
              <option value="wrong_pain">Wrong pain</option>
              <option value="tone_off">Tone off</option>
              <option value="wrong_contact">Wrong contact</option>
              <option value="other">Other</option>
            </Select>
            <Input
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Why specifically? (free text)"
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
          <p className="text-[10px] text-[var(--color-fg-700)]">
            "{rejectKind.replace(/_/g, " ")}" rejections downrank that
            (case, pain) pair for 30 days so the next pitch picks
            differently.
          </p>
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
          Claude (Sonnet) composes the {pitch.prospect_language === "es" ? "Spanish" : "English"}{" "}
          copy: it picks the best-evidenced pain and a size/industry-matched case study,
          then writes the email against Runna&apos;s voice rules. Facts are constrained to
          the prospect&apos;s scraped data and the case study&apos;s real metrics — it must
          not invent attributes. If Claude is unavailable, it falls back to a deterministic
          industry template with the same structure.
        </p>
      </details>
    </div>
  );
}

// ── Email body preview ────────────────────────────────────────────────────────

/**
 * Client-side mirror of buildHtmlBody() from lib/gmail/client.ts.
 * Renders the plain-text pitch body as React JSX so the pitch editor can
 * show exactly how the CTA line will look as a button in the recipient's inbox.
 */
function EmailBodyPreview({ body, lang }: { body: string; lang: "en" | "es" | null }) {
  const lines = body.split("\n");

  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif" }}>
      {lines.map((line, i) => {
        const trimmed = line.trim();

        if (trimmed.startsWith("👉")) {
          const withoutEmoji = trimmed.replace(/^👉\s*/, "");
          // URL can sit mid-sentence now — match anywhere, strip trailing punctuation.
          const rawMatch = withoutEmoji.match(/https?:\/\/\S+/);
          const rawUrl = rawMatch ? rawMatch[0] : null;
          const url = rawUrl ? rawUrl.replace(/[.,;:!?)\]]+$/, "") : null;

          if (rawUrl && url) {
            const [beforeRaw = "", afterRaw = ""] = withoutEmoji.split(rawUrl);
            const before = beforeRaw.replace(/[:\s—–-]+$/, "").trim();
            const after = afterRaw.replace(/^[.,:\s—–-]+/, "").trim();
            const buttonText = deriveButtonLabel(before || after, lang ?? undefined);
            return (
              <React.Fragment key={i}>
                {before ? (
                  <p style={{ margin: "16px 0 8px 0", fontSize: 13, color: "#1a1a1a" }}>
                    {before}
                  </p>
                ) : null}
                <p style={{ margin: "8px 0", fontSize: 13 }}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "inline-block",
                      padding: "11px 22px",
                      backgroundColor: "#775cbf",
                      color: "#ffffff",
                      textDecoration: "none",
                      borderRadius: 6,
                      fontSize: 14,
                      fontWeight: 500,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {buttonText}
                  </a>
                </p>
                {after ? (
                  <p style={{ margin: "8px 0 16px 0", fontSize: 13, color: "#1a1a1a", lineHeight: 1.6 }}>
                    {after}
                  </p>
                ) : null}
              </React.Fragment>
            );
          }

          return (
            <p key={i} style={{ margin: "8px 0", fontSize: 13, color: "#1a1a1a" }}>
              {withoutEmoji}
            </p>
          );
        }

        if (trimmed === "") {
          return <p key={i} style={{ margin: 0, lineHeight: 1.6 }}>&nbsp;</p>;
        }

        return (
          <p key={i} style={{ margin: 0, lineHeight: 1.6, fontSize: 13, color: "#1a1a1a" }}>
            {trimmed}
          </p>
        );
      })}
    </div>
  );
}

function deriveButtonLabel(description: string, lang?: "en" | "es"): string {
  const lower = description.toLowerCase();
  // Language wins over keyword sniffing. The industry templates emit a bare
  // "👉 {link}" with no surrounding text, so every keyword check missed and a
  // Spanish email rendered an English button ("Run my free audit →").
  // Inferring language from prose was always the wrong signal — the pitch
  // knows its own language.
  if (lang === "es") return "Ver diagnóstico gratis →";
  if (
    lower.includes("gratis") ||
    lower.includes("diagnóstico") ||
    lower.includes("auditoría") ||
    lower.includes("auditoria") ||
    lower.includes("fugas") ||
    lower.includes("pierde") ||
    lower.includes("número")
  ) {
    return "Ver diagnóstico gratis →";
  }
  if (lower.includes("see for yourself") || lower.includes("the data") || lower.includes("free tool") || lower.includes("free platform")) {
    return "See it for yourself →";
  }
  if (lower.includes("audit") || lower.includes("leak") || lower.includes("losing")) {
    return "Run my free audit →";
  }
  if (lower.includes("number") || lower.includes("revenue")) {
    return "See your store's number →";
  }
  return "Run my free audit →";
}

