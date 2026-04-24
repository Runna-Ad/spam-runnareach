"use client";

import { Plus } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { Icp } from "@/lib/icp/queries";
import { IcpCard } from "./icp-card";
import { IcpEditDrawer, type IcpDrawerMode } from "./icp-edit-drawer";

interface IcpGridProps {
  icps: Icp[];
}

export function IcpGrid({ icps }: IcpGridProps) {
  const [showInactive, setShowInactive] = React.useState(false);
  const [drawerMode, setDrawerMode] = React.useState<IcpDrawerMode | null>(null);

  const activeCount = icps.filter((i) => i.is_active).length;
  const inactiveCount = icps.length - activeCount;

  const visible = React.useMemo(
    () => (showInactive ? icps : icps.filter((i) => i.is_active)),
    [icps, showInactive],
  );

  const openEdit = (id: string) => {
    const icp = icps.find((i) => i.id === id);
    if (icp) setDrawerMode({ kind: "edit", icp });
  };

  const openCreate = () => setDrawerMode({ kind: "create" });

  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4 text-[11px] tracking-tight">
        <span className="font-mono text-xs text-[var(--color-fg-500)]">/icp</span>
        <span className="mx-1 text-[var(--color-fg-700)]">·</span>
        <span className="text-[var(--color-fg-500)]">
          <span className="font-medium text-[var(--color-fg-50)]">{activeCount}</span> active
        </span>
        {inactiveCount > 0 ? (
          <>
            <span className="mx-1 text-[var(--color-fg-700)]">·</span>
            <span className="text-[var(--color-fg-500)]">
              <span className="font-medium text-[var(--color-fg-300)]">{inactiveCount}</span>{" "}
              archived
            </span>
          </>
        ) : null}
        <label className="ml-3 inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--color-fg-500)]">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--color-accent-300)]"
          />
          Show archived
        </label>
        <div className="ml-auto">
          <Button type="button" size="sm" variant="primary" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> New ICP
          </Button>
        </div>
      </div>

      <div className="p-4">
        {visible.length === 0 ? (
          <EmptyState
            title={showInactive || icps.length === 0 ? "No ICPs yet" : "No active ICPs"}
            description={
              icps.length === 0
                ? "Create the first ICP to let Discovery start sourcing companies."
                : "All ICPs are archived. Flip the 'Show archived' toggle to review them."
            }
            action={
              icps.length === 0 ? (
                <Button type="button" variant="primary" onClick={openCreate}>
                  <Plus className="h-3.5 w-3.5" aria-hidden /> New ICP
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {visible.map((icp) => (
              <IcpCard key={icp.id} icp={icp} onOpen={openEdit} />
            ))}
          </div>
        )}
      </div>

      <IcpEditDrawer
        mode={drawerMode}
        open={drawerMode !== null}
        onOpenChange={(open) => {
          if (!open) setDrawerMode(null);
        }}
      />
    </>
  );
}
