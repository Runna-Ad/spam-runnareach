"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { addHunterScanToPipeline, markHunterScanAsWin } from "@/lib/hunter/actions";
import type { HunterScan } from "@/lib/hunter/types";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Filter,
  Globe,
  Loader2,
} from "lucide-react";
import React from "react";
import { toast } from "sonner";

interface Props {
  initialScans: HunterScan[];
  total: number;
}

type Market = "all" | "CA" | "MX";
type Status = "all" | "contacted" | "not-contacted";
type HasWebsite = "all" | "yes" | "no";

function formatRelative(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatCurrency(amount: number, market: string): string {
  const isMX = market === "mx" || market === "MX";
  const currency = isMX ? "MXN" : "CAD";
  return new Intl.NumberFormat(isMX ? "es-MX" : "en-CA", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount) + ` ${currency}`;
}

function SignalDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-xs"
      title={label}
    >
      <span
        className={ok ? "text-[var(--color-success-300)]" : "text-[var(--color-danger-300)]"}
      >
        {ok ? "✓" : "✗"}
      </span>
      <span className="text-[var(--color-fg-500)]">{label}</span>
    </span>
  );
}

function LeadRow({ scan }: { scan: HunterScan }) {
  const [expanded, setExpanded] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [actionDone, setActionDone] = React.useState(false);

  const signals = scan.signals ?? {};
  const findings = scan.results?.findings ?? [];

  function handleAddToPipeline() {
    startTransition(async () => {
      const res = await addHunterScanToPipeline(scan.id);
      if (res.ok) {
        toast.success("Added to pipeline");
        setActionDone(true);
      } else {
        toast.error(res.error ?? "Failed to add to pipeline");
      }
    });
  }

  function handleMarkAsWin() {
    startTransition(async () => {
      const res = await markHunterScanAsWin(scan.id);
      if (res.ok) {
        toast.success("Marked as win");
        setActionDone(true);
      } else {
        toast.error(res.error ?? "Failed to mark as win");
      }
    });
  }

  const showAddToPipeline = !!scan.website_url && !scan.contacted && !actionDone;
  const showMarkAsWin = scan.contacted && !actionDone;

  return (
    <li className="border-b border-[var(--color-border-default)] last:border-0">
      {/* Row */}
      <button
        type="button"
        className="w-full cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--color-bg-800)] transition-colors">
          {/* Date */}
          <span className="w-16 shrink-0 text-xs text-[var(--color-fg-500)]">
            {formatRelative(scan.created_at)}
          </span>

          {/* Market flag */}
          <span className="shrink-0 text-base" title={scan.market}>
            {scan.market === "mx" || scan.market === "MX" ? "🇲🇽" : "🇨🇦"}
          </span>

          {/* Industry */}
          <span className="w-32 min-w-0 truncate text-left text-xs text-[var(--color-fg-300)]">
            {scan.industry}
          </span>

          {/* Team + timesink */}
          <div className="hidden sm:flex items-center gap-2">
            <Chip tone="neutral">{scan.team_size}</Chip>
            <Chip tone="neutral">{scan.timesink}</Chip>
          </div>

          {/* Website */}
          <div className="hidden md:block">
            {scan.website_url ? (
              <a
                href={scan.website_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-xs text-[var(--color-accent-300)] hover:underline"
              >
                <Globe className="size-3" />
                <span className="max-w-[120px] truncate">{scan.website_url.replace(/^https?:\/\//, "")}</span>
              </a>
            ) : (
              <span className="text-xs text-[var(--color-fg-500)]">—</span>
            )}
          </div>

          {/* Value */}
          <span className="ml-auto shrink-0 text-xs font-medium text-[var(--color-fg-50)]">
            {scan.results?.total != null
              ? formatCurrency(scan.results.total, scan.market)
              : "—"}
          </span>

          {/* Contacted */}
          <div className="shrink-0" title={scan.contacted_at ? `Contacted ${formatRelative(scan.contacted_at)}` : undefined}>
            {scan.contacted ? (
              <Chip tone="success">
                <CheckCircle2 className="size-3" />
                Contacted
              </Chip>
            ) : (
              <Chip tone="neutral">
                <Clock className="size-3" />
                Not contacted
              </Chip>
            )}
          </div>

          {/* Expand icon */}
          <span className="shrink-0 text-[var(--color-fg-500)]">
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </span>
        </div>
      </button>

      {/* Expanded */}
      {expanded && (
        <div className="border-t border-[var(--color-border-default)] bg-[var(--color-bg-800)] px-4 py-4 space-y-4">
          {/* Findings */}
          {findings.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium text-[var(--color-fg-500)] uppercase tracking-wider">
                Findings
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {findings.slice(0, 3).map((f, i) => (
                  <div
                    key={i}
                    className="rounded-[var(--radius-md)] bg-[var(--color-bg-700)] p-3 ring-1 ring-inset ring-[var(--color-border-default)]"
                  >
                    <p className="text-xs font-medium text-[var(--color-fg-50)]">{f.title}</p>
                    <p className="mt-0.5 text-xs text-[var(--color-fg-500)]">{f.solution}</p>
                    <div className="mt-2 flex items-center gap-1.5 text-xs">
                      <span className="font-medium text-[var(--color-success-300)]">
                        {formatCurrency(f.amount, scan.market)}
                      </span>
                      <span className="text-[var(--color-fg-500)]">· {f.frame}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Signals */}
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--color-fg-500)] uppercase tracking-wider">
              Website Signals
            </p>
            <div className="flex flex-wrap gap-4">
              <SignalDot ok={!!signals.metaPixel} label="Meta Pixel" />
              <SignalDot ok={!!signals.analytics} label="Analytics" />
              <SignalDot ok={!!signals.emailCapture} label="Email Capture" />
              <SignalDot ok={!!signals.mobileViewport} label="Mobile Viewport" />
            </div>
          </div>

          {/* Actions */}
          {(showAddToPipeline || showMarkAsWin) && (
            <div className="flex gap-2">
              {showAddToPipeline && (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={pending}
                  onClick={handleAddToPipeline}
                >
                  {pending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <ArrowRight className="size-3" />
                  )}
                  Add to pipeline
                </Button>
              )}
              {showMarkAsWin && (
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={handleMarkAsWin}
                  className="bg-[color-mix(in_oklab,var(--color-success-500),transparent_20%)] text-[var(--color-success-300)] ring-1 ring-inset ring-[color-mix(in_oklab,var(--color-success-500),transparent_60%)] hover:bg-[color-mix(in_oklab,var(--color-success-500),transparent_10%)]"
                >
                  {pending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-3" />
                  )}
                  Mark as win
                </Button>
              )}
            </div>
          )}

          {actionDone && (
            <Chip tone="success">
              <CheckCircle2 className="size-3" />
              Done
            </Chip>
          )}
        </div>
      )}
    </li>
  );
}

export function HunterLeadsList({ initialScans, total }: Props) {
  const [market, setMarket] = React.useState<Market>("all");
  const [industry, setIndustry] = React.useState("all");
  const [status, setStatus] = React.useState<Status>("all");
  const [hasWebsite, setHasWebsite] = React.useState<HasWebsite>("all");

  const industries = React.useMemo(() => {
    const set = new Set(initialScans.map((s) => s.industry).filter(Boolean));
    return ["all", ...Array.from(set).sort()];
  }, [initialScans]);

  const filtered = React.useMemo(() => {
    return [...initialScans]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .filter((s) => {
        if (market !== "all" && s.market.toLowerCase() !== market.toLowerCase()) return false;
        if (industry !== "all" && s.industry !== industry) return false;
        if (status === "contacted" && !s.contacted) return false;
        if (status === "not-contacted" && s.contacted) return false;
        if (hasWebsite === "yes" && !s.website_url) return false;
        if (hasWebsite === "no" && !!s.website_url) return false;
        return true;
      });
  }, [initialScans, market, industry, status, hasWebsite]);

  const selectCls =
    "h-8 rounded-[var(--radius-md)] border-0 bg-[var(--color-bg-700)] px-2.5 text-xs text-[var(--color-fg-300)] ring-1 ring-inset ring-[var(--color-border-default)] focus:outline-none focus:ring-[var(--color-accent-300)]";

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Filter className="size-4 shrink-0 text-[var(--color-fg-500)]" />

        <select className={selectCls} value={market} onChange={(e) => setMarket(e.target.value as Market)}>
          <option value="all">All markets</option>
          <option value="CA">🇨🇦 Canada</option>
          <option value="MX">🇲🇽 Mexico</option>
        </select>

        <select className={selectCls} value={industry} onChange={(e) => setIndustry(e.target.value)}>
          {industries.map((i) => (
            <option key={i} value={i}>
              {i === "all" ? "All industries" : i}
            </option>
          ))}
        </select>

        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
          <option value="all">All statuses</option>
          <option value="contacted">Contacted</option>
          <option value="not-contacted">Not contacted</option>
        </select>

        <select className={selectCls} value={hasWebsite} onChange={(e) => setHasWebsite(e.target.value as HasWebsite)}>
          <option value="all">Website: any</option>
          <option value="yes">Has website</option>
          <option value="no">No website</option>
        </select>

        <span className="ml-auto text-xs text-[var(--color-fg-500)]">
          {filtered.length} of {total}
        </span>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={<AlertTriangle className="size-6" />}
          title="No leads match your filters"
          description="Try adjusting the filters above."
        />
      ) : (
        <Card>
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-[var(--color-border-default)] px-4 py-2">
            <span className="w-16 shrink-0 text-xs font-medium text-[var(--color-fg-500)]">When</span>
            <span className="shrink-0 text-xs font-medium text-[var(--color-fg-500)]">Mkt</span>
            <span className="w-32 text-xs font-medium text-[var(--color-fg-500)]">Industry</span>
            <div className="hidden sm:flex gap-2 text-xs font-medium text-[var(--color-fg-500)]">
              <span className="w-20">Team</span>
              <span className="w-24">Time sink</span>
            </div>
            <span className="hidden md:block w-32 text-xs font-medium text-[var(--color-fg-500)]">Website</span>
            <span className="ml-auto text-xs font-medium text-[var(--color-fg-500)]">Value</span>
            <span className="w-24 text-xs font-medium text-[var(--color-fg-500)]">Status</span>
            <span className="w-4" />
          </div>
          <ul>
            {filtered.map((scan) => (
              <LeadRow key={scan.id} scan={scan} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
