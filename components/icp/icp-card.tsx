"use client";

import { Archive, Users } from "lucide-react";
import { Chip } from "@/components/ui/chip";
import {
  MARKET_FLAG,
  MARKET_LABEL,
  formatEmployeeRange,
  formatRevenueRange,
} from "@/lib/icp/display";
import type { Icp } from "@/lib/icp/queries";
import { cn } from "@/lib/utils";

interface IcpCardProps {
  icp: Icp;
  onOpen: (id: string) => void;
}

export function IcpCard({ icp, onOpen }: IcpCardProps) {
  return (
    <button
      type="button"
      onClick={() => onOpen(icp.id)}
      className={cn(
        "group flex flex-col gap-3 rounded-[var(--radius-lg)] p-4 text-left",
        "bg-[var(--color-bg-800)] ring-1 ring-inset ring-[var(--color-border-default)]",
        "transition-[background,box-shadow]",
        "duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
        "hover:bg-[var(--color-bg-700)] hover:ring-[var(--color-border-strong)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-300)]",
        !icp.is_active && "opacity-55",
      )}
      aria-label={`Edit ICP: ${icp.name}`}
    >
      <div className="flex items-start gap-2.5">
        {/* Market flag in a subtle container */}
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-bg-700)] text-xl">
          <span aria-label={MARKET_LABEL[icp.market]} title={MARKET_LABEL[icp.market]}>
            {MARKET_FLAG[icp.market]}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug tracking-tight text-[var(--color-fg-50)]">
            {icp.name}
          </h3>
          <p className="mt-0.5 text-[11px] text-[var(--color-fg-500)]">
            {MARKET_LABEL[icp.market]} · {icp.language.toUpperCase()}
          </p>
        </div>
        {!icp.is_active ? (
          <span
            title="Archived"
            aria-label="Archived"
            className="shrink-0 text-[var(--color-fg-700)]"
          >
            <Archive className="h-3.5 w-3.5" aria-hidden />
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] text-[var(--color-fg-500)]">
        <Stat label="Employees">{formatEmployeeRange(icp)}</Stat>
        <Stat label="Revenue">{formatRevenueRange(icp)}</Stat>
        <Stat label="Regions">
          {icp.geo_regions.length > 0 ? icp.geo_regions.join(", ") : "—"}
        </Stat>
        <Stat label="Industries">
          {icp.industry_tags.length > 0 ? `${icp.industry_tags.length} tags` : "—"}
        </Stat>
      </div>

      <div className="flex flex-wrap gap-1">
        {icp.industry_tags.slice(0, 4).map((t) => (
          <Chip key={t} tone="neutral">
            {t}
          </Chip>
        ))}
        {icp.industry_tags.length > 4 ? (
          <Chip tone="neutral">+{icp.industry_tags.length - 4}</Chip>
        ) : null}
        {icp.industry_tags.length === 0 ? (
          <Chip tone="neutral" className="italic opacity-60">
            no industry tags
          </Chip>
        ) : null}
      </div>

      <div className="mt-auto flex items-center justify-between pt-1">
        <span
          className={cn(
            "inline-flex items-center gap-1 text-[11px]",
            icp.prospect_count > 0 || icp.reachable_pool_count !== null
              ? "text-[var(--color-fg-500)]"
              : "text-[var(--color-fg-700)]",
          )}
        >
          <Users className="h-3 w-3" aria-hidden />
          {icp.reachable_pool_count !== null
            ? `${icp.reachable_pool_count.toLocaleString()} in pool`
            : icp.prospect_count > 0
              ? `${icp.prospect_count.toLocaleString()} prospect${icp.prospect_count === 1 ? "" : "s"}`
              : "no prospects yet"}
        </span>
        <Chip tone={icp.is_active ? "success" : "neutral"}>
          {icp.is_active ? "active" : "archived"}
        </Chip>
      </div>
    </button>
  );
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
