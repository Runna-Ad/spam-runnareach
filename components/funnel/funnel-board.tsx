"use client";

import { ArrowRight, ExternalLink, GripVertical } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Chip } from "@/components/ui/chip";
import type { FunnelCard } from "@/lib/funnel/queries";
import { transitionStatus } from "@/lib/prospects/detail-actions";
import { cn, relativeTime } from "@/lib/utils";

const COLUMNS: { key: ColStatus; label: string; tone: "neutral" | "info" | "success" | "danger" | "warning" }[] = [
  { key: "raw", label: "Raw", tone: "neutral" },
  { key: "researched", label: "Researched", tone: "info" },
  { key: "pitched", label: "Pitched", tone: "info" },
  { key: "replied", label: "Replied", tone: "info" },
  { key: "booked", label: "Booked", tone: "success" },
  { key: "won", label: "Won", tone: "success" },
  { key: "lost", label: "Lost", tone: "danger" },
];

type ColStatus =
  | "raw"
  | "researched"
  | "pitched"
  | "replied"
  | "booked"
  | "won"
  | "lost";

const TERMINAL_STATUSES: Set<ColStatus> = new Set(["won", "lost"]);

const MARKET_FLAG: Record<"CA" | "MX" | "US" | "LATAM", string> = {
  CA: "🇨🇦",
  MX: "🇲🇽",
  US: "🇺🇸",
  LATAM: "🌎",
};

interface FunnelBoardProps {
  cards: FunnelCard[];
  canEdit: boolean;
}

export function FunnelBoard({ cards, canEdit }: FunnelBoardProps) {
  // Local mirror of cards so drag-drop can be optimistic. We refresh from
  // the server only on error or explicit reload — happy path is instant.
  const [state, setState] = React.useState<FunnelCard[]>(cards);
  const [dragOver, setDragOver] = React.useState<ColStatus | null>(null);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const router = useRouter();

  React.useEffect(() => {
    setState(cards);
  }, [cards]);

  // Group cards by status. Cards with statuses outside our 7 columns
  // (e.g. 'suppressed') are dropped — they live in /companies, not the
  // active funnel.
  const grouped = React.useMemo(() => {
    const out: Record<ColStatus, FunnelCard[]> = {
      raw: [],
      researched: [],
      pitched: [],
      replied: [],
      booked: [],
      won: [],
      lost: [],
    };
    for (const c of state) {
      if (c.status in out) out[c.status as ColStatus].push(c);
    }
    return out;
  }, [state]);

  const handleDrop = (target: ColStatus) => {
    const id = draggingId;
    setDragOver(null);
    setDraggingId(null);
    if (!id) return;
    const card = state.find((c) => c.id === id);
    if (!card) return;
    if (card.status === target) return;

    if (TERMINAL_STATUSES.has(target)) {
      setToast({
        tone: "warn",
        text: `Move to ${target} from the prospect page so you can capture context.`,
      });
      window.setTimeout(() => setToast(null), 4000);
      return;
    }

    const previous = card.status;
    // Optimistic update.
    setState((s) => s.map((c) => (c.id === id ? { ...c, status: target } : c)));

    React.startTransition(async () => {
      const res = await transitionStatus({ id, next_status: target });
      if (!res.ok) {
        // Revert + surface the server's reason.
        setState((s) => s.map((c) => (c.id === id ? { ...c, status: previous } : c)));
        setToast({ tone: "warn", text: res.error });
        window.setTimeout(() => setToast(null), 4500);
      } else {
        setToast({ tone: "ok", text: `Moved “${card.company_name}” → ${target.replace(/_/g, " ")}` });
        window.setTimeout(() => setToast(null), 2500);
        // Refresh server data so /companies + counts catch up.
        router.refresh();
      }
    });
  };

  const total = state.length;

  // When the board is completely empty, show a guided onboarding view
  // instead of 7 columns of "Empty." — the void communicates nothing.
  if (total === 0) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border-subtle)] px-4">
          <span className="font-mono text-xs text-[var(--color-fg-500)]">/funnel</span>
          <span className="text-[11px] text-[var(--color-fg-500)]">
            <span className="font-medium text-[var(--color-fg-50)]">0</span> in pipeline
          </span>
        </header>
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="flex max-w-md flex-col items-center gap-8 text-center">
            {/* Pipeline journey visual */}
            <div className="flex items-center gap-0">
              {[
                { label: "Raw",        color: "var(--color-fg-500)" },
                { label: "Research",   color: "var(--color-info-300)" },
                { label: "Pitch",      color: "var(--color-accent-300)" },
                { label: "Reply",      color: "var(--color-brand-gold)" },
                { label: "Booked",     color: "var(--color-brand-pink)" },
                { label: "Won",        color: "var(--color-success-300)" },
              ].map((s, i, arr) => (
                <React.Fragment key={s.label}>
                  <div className="flex flex-col items-center gap-2 px-2">
                    <div
                      className="h-2.5 w-2.5 rounded-full"
                      style={{
                        background: `color-mix(in oklab, ${s.color}, transparent 60%)`,
                        boxShadow: `0 0 6px ${s.color}40, inset 0 0 0 1px ${s.color}80`,
                      }}
                    />
                    <span
                      className="text-[9px] uppercase tracking-wider whitespace-nowrap"
                      style={{ color: s.color }}
                    >
                      {s.label}
                    </span>
                  </div>
                  {i < arr.length - 1 && (
                    <div className="mb-4 h-px w-5 bg-[var(--color-border-subtle)]" />
                  )}
                </React.Fragment>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              <h3 className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
                Your pipeline is empty
              </h3>
              <p className="text-xs leading-relaxed text-[var(--color-fg-500)]">
                Add prospects at Discover to start filling your funnel.
                Once added, drag cards between stages as they progress
                from research through to booked.
              </p>
            </div>

            <Link
              href="/discover"
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-accent-300)] px-4 py-2 text-sm font-medium text-[var(--color-bg-900)] transition-opacity hover:opacity-90"
            >
              Go to Discover
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border-subtle)] px-4">
        <span className="font-mono text-xs text-[var(--color-fg-500)]">/funnel</span>
        <span className="text-[11px] text-[var(--color-fg-500)]">
          <span className="font-medium text-[var(--color-fg-50)]">{total}</span> in pipeline
          {!canEdit ? " · view only" : ""}
        </span>
        {toast ? (
          <span
            className={cn(
              "ml-auto rounded-[var(--radius-sm)] px-2 py-1 text-[11px] ring-1",
              toast.tone === "ok"
                ? "bg-[color-mix(in_oklab,var(--color-success-500),transparent_85%)] text-[var(--color-success-300)] ring-[color-mix(in_oklab,var(--color-success-500),transparent_70%)]"
                : "bg-[color-mix(in_oklab,var(--color-warning-500),transparent_85%)] text-[var(--color-warning-300)] ring-[color-mix(in_oklab,var(--color-warning-500),transparent_70%)]",
            )}
          >
            {toast.text}
          </span>
        ) : null}
      </header>

      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full min-w-max gap-3 p-3">
          {COLUMNS.map((col) => {
            const items = grouped[col.key];
            const isDropTarget = dragOver === col.key;
            const isTerminal = TERMINAL_STATUSES.has(col.key);
            return (
              <div
                key={col.key}
                onDragOver={(e) => {
                  if (!canEdit || !draggingId) return;
                  e.preventDefault();
                  setDragOver(col.key);
                }}
                onDragLeave={() => setDragOver((d) => (d === col.key ? null : d))}
                onDrop={(e) => {
                  if (!canEdit) return;
                  e.preventDefault();
                  handleDrop(col.key);
                }}
                className={cn(
                  "flex h-full w-72 shrink-0 flex-col rounded-[var(--radius-lg)]",
                  "bg-[var(--color-bg-900)] ring-1 ring-inset",
                  isDropTarget
                    ? "ring-[var(--color-accent-300)]"
                    : "ring-[var(--color-border-subtle)]",
                  isTerminal && draggingId ? "opacity-60" : "",
                )}
              >
                <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Chip tone={col.tone}>{col.label}</Chip>
                    <span className="font-mono text-[11px] text-[var(--color-fg-500)]">
                      {items.length}
                    </span>
                  </div>
                  {isTerminal ? (
                    <span
                      className="text-[10px] uppercase tracking-wider text-[var(--color-fg-700)]"
                      title="Terminal — set from the prospect page"
                    >
                      Terminal
                    </span>
                  ) : null}
                </div>

                <div className="flex-1 overflow-y-auto p-2">
                  {items.length === 0 ? (
                    <p className="px-1 py-4 text-[10px] text-[var(--color-fg-700)] leading-relaxed">
                      {col.key === "raw" && "Prospects land here from Discover."}
                      {col.key === "researched" && "Run research from a prospect page."}
                      {col.key === "pitched" && "Generate a pitch from a prospect page."}
                      {col.key === "replied" && "Mark a reply from the Inbox."}
                      {col.key === "booked" && "Set from the prospect page."}
                      {col.key === "won" && "Set from the prospect page."}
                      {col.key === "lost" && "Set from the prospect page."}
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {items.map((c) => (
                        <FunnelCardItem
                          key={c.id}
                          card={c}
                          canEdit={canEdit}
                          dragging={draggingId === c.id}
                          onDragStart={() => setDraggingId(c.id)}
                          onDragEnd={() => {
                            setDraggingId(null);
                            setDragOver(null);
                          }}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FunnelCardItem({
  card,
  canEdit,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  card: FunnelCard;
  canEdit: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  return (
    <li>
      <div
        draggable={canEdit}
        onDragStart={(e) => {
          if (!canEdit) return;
          e.dataTransfer.effectAllowed = "move";
          // Required for Firefox to actually fire dragstart properly.
          e.dataTransfer.setData("text/plain", card.id);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        className={cn(
          "group flex flex-col gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-bg-800)] p-2.5",
          "ring-1 ring-inset ring-[var(--color-border-default)]",
          "transition-[box-shadow,opacity]",
          canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-default",
          dragging ? "opacity-40" : "hover:ring-[var(--color-accent-300)]",
        )}
      >
        <div className="flex items-start gap-1.5">
          {canEdit ? (
            <GripVertical
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-fg-700)] group-hover:text-[var(--color-fg-500)]"
              aria-hidden
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <Link
              href={`/companies/${card.id}` as never}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1.5 text-sm text-[var(--color-fg-50)] hover:text-[var(--color-accent-300)]"
            >
              <span aria-hidden>{MARKET_FLAG[card.market]}</span>
              <span className="truncate">{card.company_name}</span>
            </Link>
            {card.domain ? (
              <a
                href={`https://${card.domain}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 font-mono text-[10px] text-[var(--color-fg-500)] hover:text-[var(--color-accent-300)]"
              >
                {card.domain}
                <ExternalLink className="h-2.5 w-2.5" aria-hidden />
              </a>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!card.domain && card.status === "pitched" && (
              <span
                className="rounded-[var(--radius-sm)] px-1 py-0.5 text-[9px] font-medium bg-[color-mix(in_oklab,var(--color-info-500),transparent_80%)] text-[var(--color-info-300)]"
                title="No website — pitched on building one"
              >
                🌐 No site
              </span>
            )}
            {card.match_score !== null &&
              card.match_score >= 40 &&
              card.match_score < 70 &&
              card.status !== "pitched" && (
                <span
                  className="rounded-[var(--radius-sm)] px-1 py-0.5 text-[9px] font-medium bg-[color-mix(in_oklab,var(--color-warning-500),transparent_80%)] text-[var(--color-warning-300)]"
                  title={`Score ${card.match_score} — review and fill in missing info to unlock pitch`}
                >
                  ⚠ Review
                </span>
              )}
            {card.match_score !== null ? (
              <span
                className={cn(
                  "rounded-[var(--radius-sm)] px-1.5 py-0.5 font-mono text-[10px]",
                  card.match_score >= 70
                    ? "bg-[color-mix(in_oklab,var(--color-success-500),transparent_85%)] text-[var(--color-success-300)]"
                    : card.match_score >= 40
                      ? "bg-[color-mix(in_oklab,var(--color-info-500),transparent_85%)] text-[var(--color-info-300)]"
                      : "bg-[var(--color-bg-700)] text-[var(--color-fg-500)]",
                )}
                title={`Match score ${card.match_score}/100`}
              >
                {card.match_score}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[var(--color-fg-700)]">
          {card.icp_name ? <span className="truncate">{card.icp_name}</span> : null}
          {card.industry ? (
            <span className="truncate">· {card.industry}</span>
          ) : null}
          <span className="ml-auto shrink-0">{relativeTime(card.updated_at)}</span>
        </div>
      </div>
    </li>
  );
}
