"use client";

import {
  Activity,
  Brain,
  ChevronRight,
  Gauge,
  Globe,
  Mail,
  Plus,
  ScanSearch,
  Send,
} from "lucide-react";
import Link from "next/link";
import * as React from "react";
import type { TenantActivityEntry } from "@/lib/today/queries";
import { relativeTime } from "@/lib/utils";

interface ActivityCollapsibleProps {
  entries: TenantActivityEntry[];
}

export function ActivityCollapsible({ entries }: ActivityCollapsibleProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-800)]">
      {/* Header — always visible, click to toggle */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[var(--color-bg-700)] rounded-[var(--radius-lg)] transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[var(--color-fg-400)]" aria-hidden />
          <span className="text-sm font-semibold text-[var(--color-fg-100)]">
            Recent activity
          </span>
          {entries.length > 0 && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-[var(--color-bg-700)] text-[var(--color-fg-500)]">
              {entries.length}
            </span>
          )}
        </div>
        <ChevronRight
          className="h-4 w-4 text-[var(--color-fg-500)] transition-transform duration-200"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
          aria-hidden
        />
      </button>

      {/* Collapsible body — smooth height animation via grid trick */}
      <div
        className="grid transition-all duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="border-t border-[var(--color-border-subtle)] px-4 pb-2 pt-1">
            {entries.length === 0 ? (
              <p className="py-4 text-xs italic text-[var(--color-fg-700)]">
                No team activity yet. Scrape a prospect, run research, score, or generate a pitch.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--color-border-subtle)]">
                {entries.map((a) => (
                  <ActivityRow key={a.id} entry={a} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Helpers (moved from page.tsx) ─────────────────────────────────────────────

function ActivityIcon({ kind }: { kind: TenantActivityEntry["kind"] }) {
  const cls = "h-3.5 w-3.5 text-[var(--color-accent-300)]";
  switch (kind) {
    case "scrape":
      return <Globe className={cls} aria-hidden />;
    case "score":
      return <Gauge className={cls} aria-hidden />;
    case "status_change":
      return <ChevronRight className={cls} aria-hidden />;
    case "research_create":
    case "research_edit":
      return <ScanSearch className={cls} aria-hidden />;
    case "structured_research":
      return <Brain className={cls} aria-hidden />;
    case "pitch_generated":
      return <Mail className={cls} aria-hidden />;
    case "reply_created":
      return <Plus className={cls} aria-hidden />;
    default:
      return <Activity className={cls} aria-hidden />;
  }
}

function ActivityRow({ entry }: { entry: TenantActivityEntry }) {
  const inner = (
    <div className="flex items-start gap-3 px-1 py-2">
      <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--color-bg-900)] ring-1 ring-inset ring-[var(--color-border-default)]">
        <ActivityIcon kind={entry.kind} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm text-[var(--color-fg-50)]">{entry.label}</span>
          {entry.prospect_name ? (
            <span className="truncate text-[11px] text-[var(--color-fg-500)]">
              · {entry.prospect_name}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-fg-500)]">
          {entry.actor_name ? <span>{entry.actor_name}</span> : <span>system</span>}
          {entry.detail ? <span>· {entry.detail}</span> : null}
          <span className="ml-auto text-[var(--color-fg-700)]">{relativeTime(entry.at)}</span>
        </div>
      </div>
    </div>
  );

  if (entry.prospect_id) {
    return (
      <li>
        <Link
          href={`/companies/${entry.prospect_id}` as never}
          className="block rounded-[var(--radius-sm)] hover:bg-[var(--color-bg-700)]"
        >
          {inner}
        </Link>
      </li>
    );
  }
  return <li>{inner}</li>;
}
