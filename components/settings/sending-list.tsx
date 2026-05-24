"use client";

import { CheckCircle2, PauseCircle, Plus, XCircle } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import type { BrandLite, SenderInbox, WarmingStage } from "@/lib/settings/sending-queries";
import { cn } from "@/lib/utils";
import { SenderInboxDrawer, type SenderDrawerMode } from "./sender-inbox-drawer";

interface SendingListProps {
  inboxes: SenderInbox[];
  brands: BrandLite[];
  canManage: boolean;
  gmailError?: string | null;
  gmailConnected?: boolean;
}

export function SendingList({ inboxes, brands, canManage, gmailError, gmailConnected }: SendingListProps) {
  const [drawer, setDrawer] = React.useState<SenderDrawerMode | null>(null);

  return (
    <div className="flex flex-col gap-4 p-4">
      {gmailError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          ⚠ Gmail connect failed: {gmailError}
        </div>
      )}
      {gmailConnected && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          ✓ Gmail connected successfully.
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
            Sender inboxes
          </h2>
          <p className="text-xs text-[var(--color-fg-500)]">
            Mailboxes authorized to send outreach on behalf of a brand.
          </p>
        </div>
        {canManage ? (
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={() => setDrawer({ kind: "create" })}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> New sender inbox
          </Button>
        ) : null}
      </div>

      {inboxes.length === 0 ? (
        <EmptyState
          title="No sender inboxes yet"
          description="Add a mailbox to start. Gmail connect unlocks once Google Cloud credentials land."
          action={
            canManage ? (
              <Button type="button" variant="primary" onClick={() => setDrawer({ kind: "create" })}>
                <Plus className="h-3.5 w-3.5" aria-hidden /> New sender inbox
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {inboxes.map((inbox) => (
            <InboxCard
              key={inbox.id}
              inbox={inbox}
              disabled={!canManage}
              onOpen={() => setDrawer({ kind: "edit", inbox })}
            />
          ))}
        </div>
      )}

      <SenderInboxDrawer
        mode={drawer}
        brands={brands}
        open={drawer !== null}
        onOpenChange={(open) => {
          if (!open) setDrawer(null);
        }}
      />
    </div>
  );
}

function InboxCard({
  inbox,
  onOpen,
  disabled,
}: {
  inbox: SenderInbox;
  onOpen: () => void;
  disabled: boolean;
}) {
  return (
    <Card
      className={cn(
        "cursor-pointer transition-[background]",
        "hover:bg-[var(--color-bg-700)]",
        disabled && "pointer-events-none opacity-70",
      )}
      onClick={disabled ? undefined : onOpen}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Edit sender inbox ${inbox.email}`}
    >
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-[var(--color-fg-50)]">
              {inbox.display_name}
            </span>
            <span className="truncate text-[11px] text-[var(--color-fg-500)]">{inbox.email}</span>
          </div>
          <WarmingChip stage={inbox.warming_stage} paused={inbox.paused} />
        </div>
        <div className="grid grid-cols-3 gap-x-2 gap-y-1 text-[11px]">
          <Stat label="Brand">{inbox.brand_display_name}</Stat>
          <Stat label="Daily cap">
            {inbox.sends_today} / {inbox.daily_cap}
          </Stat>
          <Stat label="Gmail">
            {inbox.gmail_connected ? (
              <span className="inline-flex items-center gap-0.5 text-[var(--color-success-300)]">
                <CheckCircle2 className="h-3 w-3" aria-hidden /> connected
              </span>
            ) : (
              <span className="inline-flex items-center gap-0.5 text-[var(--color-fg-500)]">
                <XCircle className="h-3 w-3" aria-hidden /> not connected
              </span>
            )}
          </Stat>
        </div>
      </CardContent>
    </Card>
  );
}

function WarmingChip({ stage, paused }: { stage: WarmingStage; paused: boolean }) {
  if (paused) {
    return (
      <Chip tone="warning" className="gap-1">
        <PauseCircle className="h-3 w-3" aria-hidden /> paused
      </Chip>
    );
  }
  const tone = stage === "warm" ? "success" : stage === "blocked" ? "danger" : "info";
  return <Chip tone={tone}>{stage.replace("_", " ")}</Chip>;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-700)]">
        {label}
      </span>
      <span className="truncate text-[var(--color-fg-300)]">{children}</span>
    </div>
  );
}
