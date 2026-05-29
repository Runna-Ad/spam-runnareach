"use client";

import type { Route } from "next";
import {
  Calendar,
  CheckCircle2,
  Filter,
  Inbox as InboxIcon,
  Loader2,
  MailQuestion,
  MessageSquare,
  Plus,
  ShieldX,
  Sparkles,
  X,
} from "lucide-react";
import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createManualReply,
  markReplyHandled,
  overrideReplyIntent,
} from "@/lib/replies/actions";
import type {
  ProspectOption,
  Reply,
  ReplyIntent,
} from "@/lib/replies/queries";
import { cn, relativeTime } from "@/lib/utils";

const INTENT_META: Record<
  ReplyIntent,
  { label: string; tone: "success" | "info" | "warning" | "danger" | "neutral"; icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }> }
> = {
  wants_meeting: { label: "Wants meeting", tone: "success", icon: Calendar },
  wants_info: { label: "Wants info", tone: "info", icon: MessageSquare },
  hard_no: { label: "Hard no", tone: "danger", icon: ShieldX },
  not_now: { label: "Not now", tone: "warning", icon: MailQuestion },
  wrong_person: { label: "Wrong person", tone: "warning", icon: MailQuestion },
  auto_reply: { label: "Auto-reply", tone: "neutral", icon: InboxIcon },
  unclassified: { label: "Unclassified", tone: "neutral", icon: Sparkles },
};

const MARKET_FLAG: Record<"CA" | "MX" | "US" | "LATAM", string> = {
  CA: "🇨🇦",
  MX: "🇲🇽",
  US: "🇺🇸",
  LATAM: "🌎",
};

interface InboxPageProps {
  replies: Reply[];
  prospects: ProspectOption[];
  counts: { total: number; unclassified: number; hot: number; unhandled: number };
  migrationMissing: boolean;
  canEdit: boolean;
}

type FilterValue = "ALL" | "unhandled" | "hot" | ReplyIntent;

export function InboxPage({
  replies,
  prospects,
  counts,
  migrationMissing,
  canEdit,
}: InboxPageProps) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<FilterValue>("unhandled");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [selectedReplyId, setSelectedReplyId] = React.useState<string | null>(null);

  const visible = React.useMemo(() => {
    if (filter === "ALL") return replies;
    if (filter === "unhandled") return replies.filter((r) => !r.handled_at);
    if (filter === "hot")
      return replies.filter((r) => r.urgency === "hot" || r.intent === "wants_meeting");
    return replies.filter((r) => r.intent === filter);
  }, [replies, filter]);

  const selectedReply = React.useMemo(
    () => replies.find((r) => r.id === selectedReplyId) ?? null,
    [replies, selectedReplyId],
  );

  if (migrationMissing) {
    return (
      <div className="m-4 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-default)] bg-[var(--color-bg-900)] p-6">
        <h3 className="text-sm font-medium text-[var(--color-fg-50)]">
          Migration 0005 not applied
        </h3>
        <p className="mt-1 text-xs text-[var(--color-fg-500)]">
          The replies table needs <code>pitch_id</code> nullable so manual entries
          work pre-Phase 4. Apply{" "}
          <code>supabase/migrations/0005_replies_nullable_pitch.sql</code> in the
          Supabase SQL editor and refresh.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border-subtle)] px-4">
        <span className="font-mono text-xs text-[var(--color-fg-500)]">/inbox</span>
        <span className="text-[11px] text-[var(--color-fg-500)]">
          <span className="font-medium text-[var(--color-fg-50)]">{counts.total}</span> total ·{" "}
          <span className={counts.hot > 0 ? "font-medium text-[var(--color-success-300)]" : ""}>
            {counts.hot} hot
          </span>{" "}
          ·{" "}
          <span className={counts.unhandled > 0 ? "font-medium text-[var(--color-warning-300)]" : ""}>
            {counts.unhandled} unhandled
          </span>
          {counts.unclassified > 0 ? ` · ${counts.unclassified} unclassified` : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-[var(--color-fg-700)]" aria-hidden />
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterValue)}
            className="h-8 max-w-[180px] py-0 text-xs"
          >
            <option value="unhandled">Unhandled</option>
            <option value="hot">Hot · meeting requests</option>
            <option value="ALL">All</option>
            <option value="wants_meeting">Wants meeting</option>
            <option value="wants_info">Wants info</option>
            <option value="hard_no">Hard no</option>
            <option value="not_now">Not now</option>
            <option value="wrong_person">Wrong person</option>
            <option value="auto_reply">Auto-reply</option>
            <option value="unclassified">Unclassified</option>
          </Select>
          {canEdit ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden /> Log reply
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* List pane */}
        <div className="flex-1 overflow-y-auto border-r border-[var(--color-border-subtle)]">
          {replies.length === 0 ? (
            <EmptyState
              title="Inbox is empty"
              description="No replies yet. When pitches are sent, replies land here. Or click 'Log reply' to add one manually now."
              action={
                canEdit ? (
                  <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
                    <Plus className="h-3.5 w-3.5" aria-hidden /> Log reply
                  </Button>
                ) : undefined
              }
            />
          ) : visible.length === 0 ? (
            <EmptyState
              title="No replies match this filter"
              description="Try a different filter — 'Unhandled' is the default action queue."
            />
          ) : (
            <ul className="divide-y divide-[var(--color-border-subtle)]">
              {visible.map((r) => (
                <ReplyRow
                  key={r.id}
                  reply={r}
                  active={r.id === selectedReplyId}
                  onClick={() => setSelectedReplyId(r.id)}
                />
              ))}
            </ul>
          )}
        </div>

        {/* Detail pane */}
        <div className="hidden w-[420px] shrink-0 overflow-y-auto md:block">
          {selectedReply ? (
            <ReplyDetail
              reply={selectedReply}
              canEdit={canEdit}
              onChange={() => router.refresh()}
              onClose={() => setSelectedReplyId(null)}
            />
          ) : (
            <div className="m-4 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-default)] bg-[var(--color-bg-900)] p-6 text-xs text-[var(--color-fg-500)]">
              Pick a reply on the left to see details.
            </div>
          )}
        </div>
      </div>

      <CreateReplyDrawer
        open={createOpen}
        onOpenChange={setCreateOpen}
        prospects={prospects}
        onCreated={() => {
          setCreateOpen(false);
          router.refresh();
        }}
      />
    </div>
  );
}

function ReplyRow({
  reply,
  active,
  onClick,
}: {
  reply: Reply;
  active: boolean;
  onClick: () => void;
}) {
  const meta = INTENT_META[reply.intent];
  const Icon = meta.icon;
  const handled = Boolean(reply.handled_at);
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
          <Chip tone={meta.tone}>
            <Icon className="h-3 w-3" aria-hidden /> {meta.label}
          </Chip>
          {reply.urgency === "hot" ? (
            <span className="text-[10px] uppercase tracking-wider text-[var(--color-success-300)]">
              hot
            </span>
          ) : null}
          {handled ? (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-[var(--color-fg-700)]">
              <CheckCircle2 className="h-3 w-3" aria-hidden /> handled
            </span>
          ) : null}
          <span className="ml-auto text-[10px] text-[var(--color-fg-700)]">
            {relativeTime(reply.received_at)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {reply.prospect_market ? (
            <span aria-hidden>{MARKET_FLAG[reply.prospect_market]}</span>
          ) : null}
          <span className="truncate text-sm text-[var(--color-fg-50)]">
            {reply.prospect_name ?? reply.from_email}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-fg-500)]">
          <span className="truncate font-mono">{reply.from_email}</span>
        </div>
        {reply.subject ? (
          <div className="truncate text-[11px] text-[var(--color-fg-300)]">
            {reply.subject}
          </div>
        ) : null}
      </button>
    </li>
  );
}

function ReplyDetail({
  reply,
  canEdit,
  onChange,
  onClose,
}: {
  reply: Reply;
  canEdit: boolean;
  onChange: () => void;
  onClose: () => void;
}) {
  const [pendingIntent, startIntent] = React.useTransition();
  const [pendingHandle, startHandle] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const meta = INTENT_META[reply.intent];

  const setIntent = (intent: ReplyIntent) => {
    setError(null);
    startIntent(async () => {
      const res = await overrideReplyIntent({ reply_id: reply.id, intent });
      if (res.ok) onChange();
      else setError(res.error);
    });
  };

  const handle = () => {
    setError(null);
    startHandle(async () => {
      const res = await markReplyHandled({ reply_id: reply.id });
      if (res.ok) onChange();
      else setError(res.error);
    });
  };

  return (
    <div className="m-4 flex flex-col gap-4 rounded-[var(--radius-lg)] bg-[var(--color-bg-800)] p-4 ring-1 ring-inset ring-[var(--color-border-default)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Chip tone={meta.tone}>{meta.label}</Chip>
          <h3 className="mt-2 truncate text-sm font-medium text-[var(--color-fg-50)]">
            {reply.subject ?? "(no subject)"}
          </h3>
          <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-fg-500)]">
            from {reply.from_email}
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--color-fg-700)]">
            received {relativeTime(reply.received_at)}
            {reply.classified_at ? ` · classified ${relativeTime(reply.classified_at)}` : ""}
          </p>
          {reply.prospect_id && reply.prospect_name ? (
            <Link
              href={`/companies/${reply.prospect_id}` as Route}
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--color-accent-300)] hover:underline"
            >
              <span aria-hidden>{reply.prospect_market ? MARKET_FLAG[reply.prospect_market] : ""}</span>
              {reply.prospect_name} →
            </Link>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[var(--color-fg-500)] hover:bg-[var(--color-bg-700)] hover:text-[var(--color-fg-50)]"
          aria-label="Close detail"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {reply.body_text ? (
        <pre className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-bg-900)] p-3 text-[12px] leading-relaxed text-[var(--color-fg-300)]">
          {reply.body_text}
        </pre>
      ) : (
        <p className="text-[11px] italic text-[var(--color-fg-700)]">No body captured.</p>
      )}

      {canEdit ? (
        <div className="flex flex-col gap-3 border-t border-[var(--color-border-subtle)] pt-3">
          <div>
            <Label className="text-[10px] uppercase tracking-wider">Override intent</Label>
            <Select
              value={reply.intent}
              onChange={(e) => setIntent(e.target.value as ReplyIntent)}
              disabled={pendingIntent}
              className="mt-1 h-8 text-xs"
            >
              {Object.entries(INTENT_META).map(([v, m]) => (
                <option key={v} value={v}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
          <Button
            type="button"
            variant="primary"
            onClick={handle}
            disabled={pendingHandle || Boolean(reply.handled_at)}
          >
            {pendingHandle ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            )}
            {reply.handled_at
              ? `Handled ${relativeTime(reply.handled_at)}${reply.handled_by_name ? ` by ${reply.handled_by_name}` : ""}`
              : "Mark handled"}
          </Button>
          {error ? <p className="text-[11px] text-[var(--color-danger-300)]">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function CreateReplyDrawer({
  open,
  onOpenChange,
  prospects,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  prospects: ProspectOption[];
  onCreated: () => void;
}) {
  const [from, setFrom] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [prospectId, setProspectId] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, startSaving] = React.useTransition();

  React.useEffect(() => {
    if (open) {
      setFrom("");
      setSubject("");
      setBody("");
      setProspectId("");
      setError(null);
    }
  }, [open]);

  const handleSave = () => {
    setError(null);
    startSaving(async () => {
      const res = await createManualReply({
        prospect_id: prospectId || null,
        from_email: from.trim(),
        subject: subject.trim() || null,
        body_text: body.trim() || null,
      });
      if (res.ok) onCreated();
      else setError(res.error);
    });
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Log a reply manually</DrawerTitle>
          <DrawerDescription>
            Paste the email reply you received. Claude (Haiku) auto-classifies
            intent — falls back to the deterministic heuristic if Claude is
            unavailable. Link a prospect so it shows up in their activity feed.
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="from">From email</Label>
              <Input
                id="from"
                type="email"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="sarah@example.com"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prospect">Prospect (optional)</Label>
              <Select
                id="prospect"
                value={prospectId}
                onChange={(e) => setProspectId(e.target.value)}
              >
                <option value="">— Pick a prospect —</option>
                {prospects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {MARKET_FLAG[p.market]} {p.company_name}
                  </option>
                ))}
              </Select>
              <p className="text-[10px] text-[var(--color-fg-700)]">
                Required pre-Phase 4. Phase 4 will auto-link via the pitch_id.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="subject">Subject</Label>
              <Input
                id="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Re: quick question about your DTC roastery"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="body">Body</Label>
              <Textarea
                id="body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                placeholder="Hey — yes, happy to chat next week. Could you send over a Calendly?"
              />
            </div>
          </div>
        </DrawerBody>
        <DrawerFooter>
          {error ? (
            <p className="mr-auto max-w-md truncate text-xs text-[var(--color-danger-300)]">
              {error}
            </p>
          ) : null}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleSave}
            disabled={saving || !from.trim() || !prospectId}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {saving ? "Saving…" : "Log reply + classify"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
