"use client";

import type { Route } from "next";

import { ArrowRight, Building2, ExternalLink, Filter, Gauge, Loader2, Search, Trash2, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { bulkDeleteProspects, bulkRunPipeline, bulkScoreProspects, bulkTransitionStatus } from "@/lib/discover/bulk-actions";
import type { Prospect } from "@/lib/discover/prospects-queries";
import { useDebounce } from "@/lib/hooks";
import { cn, relativeTime } from "@/lib/utils";

type SortOption = "newest" | "oldest" | "score_desc" | "score_asc" | "name";

interface InitialFilters {
  status: string;
  market: string;
  icpId: string;
  sort: string;
  search: string;
}

interface CompaniesPageProps {
  prospects: Prospect[];
  icps: { id: string; name: string }[];
  initialFilters?: InitialFilters;
}

const STATUS_OPTIONS: string[] = [
  "raw",
  "researched",
  "pitched",
  "replied",
  "booked",
  "won",
  "lost",
  "suppressed",
];

const STATUS_TONE: Record<string, "info" | "neutral" | "success" | "danger" | "warning" | "accent"> = {
  raw: "neutral",       // grey — untouched
  researched: "info",   // blue — analyzed
  pitched: "accent",    // purple — outreach drafted/sent (distinct from researched)
  replied: "success",   // green — they responded
  booked: "success",    // green — meeting booked (key was wrongly "meeting_booked")
  won: "success",       // green — closed
  lost: "danger",       // red
  suppressed: "warning",// amber — manually hidden
};

const MARKET_FLAG: Record<"CA" | "MX" | "US" | "LATAM", string> = {
  CA: "🇨🇦",
  MX: "🇲🇽",
  US: "🇺🇸",
  LATAM: "🌎",
};

export function CompaniesPage({ prospects, icps, initialFilters }: CompaniesPageProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [search, setSearch] = React.useState(initialFilters?.search ?? "");
  const debouncedSearch = useDebounce(search, 200);
  const [status, setStatus] = React.useState<string>(initialFilters?.status ?? "ALL");
  const [market, setMarket] = React.useState<string>(initialFilters?.market ?? "ALL");
  const [icpId, setIcpId] = React.useState<string>(initialFilters?.icpId ?? "ALL");
  const [sort, setSort] = React.useState<SortOption>(
    (initialFilters?.sort as SortOption | undefined) ?? "newest",
  );

  // Selection state for bulk actions. Set of prospect ids. Cleared on
  // any filter change so we don't bulk-act on rows the user can't see.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkPending, startBulk] = React.useTransition();
  const [bulkToast, setBulkToast] = React.useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = React.useState(false);

  React.useEffect(() => {
    setSelected(new Set());
  }, [status, market, icpId, search]);

  // Sync filter state → URL (shallow replace, no scroll). Deeplinks like
  // /companies?status=raw work both ways: the page hydrates from URL on
  // mount, and changing a filter updates the URL so it can be copied.
  React.useEffect(() => {
    const params = new URLSearchParams();
    if (status !== "ALL") params.set("status", status);
    if (market !== "ALL") params.set("market", market);
    if (icpId !== "ALL") params.set("icp", icpId);
    if (sort !== "newest") params.set("sort", sort);
    if (debouncedSearch.trim().length > 0) params.set("q", debouncedSearch.trim());
    const qs = params.toString();
    const next = qs ? `${pathname}?${qs}` : pathname;
    // Avoid pointless replaces — they cancel in-flight scrolls.
    if (typeof window !== "undefined" && window.location.pathname + window.location.search !== next) {
      router.replace(next as Route, { scroll: false });
    }
  }, [status, market, icpId, sort, debouncedSearch, pathname, router]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    // "Needs contact" = a scored, still-active prospect we couldn't reach (no
    // email). NOT a bad fit, so it isn't suppressed; it's a separate
    // manual-outreach worklist (LinkedIn / site form) + a learning signal, kept
    // out of the ideal pitch-ready flow. Any score qualifies — score-sort inside
    // the tab to prioritise the strong fits. Only early-funnel statuses (raw /
    // researched) — once pitched/replied a prospect is past the contact stage.
    const isNeedsContact = (p: Prospect) =>
      !p.has_contact &&
      p.match_score != null &&
      (p.status === "raw" || p.status === "researched") &&
      p.pitch_status !== "sent";

    const out = prospects.filter((p) => {
      if (status === "needs_contact") return isNeedsContact(p);

      // Default "All" view = active working list. Keep out (a) suppressed/archived,
      // (b) pitches already SENT, and (c) the "needs contact" worklist — all of
      // which just dirty the ideal flow. Each is reachable via its own filter/view.
      if (
        status === "ALL" &&
        (p.status === "suppressed" ||
          p.status === "no_match" ||
          p.pitch_status === "sent" ||
          isNeedsContact(p))
      ) {
        return false;
      }
      if (status !== "ALL" && p.status !== status) return false;
      if (market !== "ALL" && p.market !== market) return false;
      if (icpId !== "ALL" && p.icp_id !== icpId) return false;
      if (term.length > 0) {
        const hay = [p.company_name, p.domain ?? "", p.industry ?? "", p.city ?? ""]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });

    out.sort((a, b) => {
      switch (sort) {
        case "score_desc":
          return (b.match_score ?? -1) - (a.match_score ?? -1);
        case "score_asc":
          return (a.match_score ?? Number.MAX_SAFE_INTEGER) - (b.match_score ?? Number.MAX_SAFE_INTEGER);
        case "oldest":
          return a.created_at.localeCompare(b.created_at);
        case "name":
          return a.company_name.localeCompare(b.company_name);
        case "newest":
        default:
          return b.created_at.localeCompare(a.created_at);
      }
    });

    return out;
  }, [prospects, status, market, icpId, search, sort]);

  const counts = React.useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of prospects) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [prospects]);

  // ── Bulk action helpers ───────────────────────────────────────────────
  const visibleIds = React.useMemo(() => filtered.map((p) => p.id), [filtered]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected =
    !allVisibleSelected && visibleIds.some((id) => selected.has(id));

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkSetStatus = (next_status: "raw" | "researched" | "pitched" | "suppressed") => {
    if (selected.size === 0) return;
    setBulkToast(null);
    const ids = Array.from(selected);
    startBulk(async () => {
      const res = await bulkTransitionStatus({
        prospect_ids: ids,
        next_status,
        suppressed_reason: next_status === "suppressed" ? "manual bulk suppression" : null,
      });
      if (res.ok) {
        setBulkToast({
          tone: "ok",
          text: `${res.affected} prospect${res.affected === 1 ? "" : "s"} → ${next_status}`,
        });
        setSelected(new Set());
        router.refresh();
      } else {
        setBulkToast({ tone: "warn", text: res.error });
      }
      window.setTimeout(() => setBulkToast(null), 4000);
    });
  };

  const bulkPipeline = () => {
    if (selected.size === 0) return;
    if (selected.size > 20) {
      setBulkToast({ tone: "warn", text: "Pipeline caps at 20 prospects per batch." });
      return;
    }
    setBulkToast(null);
    const ids = Array.from(selected);
    startBulk(async () => {
      const res = await bulkRunPipeline({ prospect_ids: ids });
      if (res.ok) {
        const detail = res.failed > 0 ? ` (${res.failed} failed${res.details ? ` — ${res.details}` : ""})` : "";
        setBulkToast({
          tone: res.failed > 0 ? "warn" : "ok",
          text: `Pipeline complete: ${res.affected} processed${detail}`,
        });
        setSelected(new Set());
        router.refresh();
      } else {
        setBulkToast({ tone: "warn", text: res.error });
      }
      window.setTimeout(() => setBulkToast(null), 8000);
    });
  };

  const bulkScore = () => {
    if (selected.size === 0) return;
    if (selected.size > 100) {
      setBulkToast({ tone: "warn", text: "Score caps at 100 prospects per batch." });
      return;
    }
    setBulkToast(null);
    const ids = Array.from(selected);
    startBulk(async () => {
      const res = await bulkScoreProspects({ prospect_ids: ids });
      if (res.ok) {
        const detail = res.failed > 0
          ? ` (${res.failed} failed${res.details ? ` — ${res.details}` : ""})`
          : res.details ? ` — ${res.details}` : "";
        setBulkToast({
          tone: res.failed > 0 ? "warn" : "ok",
          text: `Scored ${res.affected} prospect${res.affected === 1 ? "" : "s"}${detail}`,
        });
        setSelected(new Set());
        router.refresh();
      } else {
        setBulkToast({ tone: "warn", text: res.error });
      }
      window.setTimeout(() => setBulkToast(null), 5000);
    });
  };

  const bulkDelete = () => {
    if (selected.size === 0) return;
    setBulkToast(null);
    const ids = Array.from(selected);
    startBulk(async () => {
      const res = await bulkDeleteProspects({ prospect_ids: ids });
      setConfirmDeleteOpen(false);
      if (res.ok) {
        const detail = res.failed > 0 && res.details ? ` — ${res.details}` : "";
        setBulkToast({
          tone: res.failed > 0 ? "warn" : "ok",
          text: `Deleted ${res.affected} prospect${res.affected === 1 ? "" : "s"}${detail}`,
        });
        setSelected(new Set());
        router.refresh();
      } else {
        setBulkToast({ tone: "warn", text: res.error });
      }
      window.setTimeout(() => setBulkToast(null), 6000);
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border-subtle)] px-4">
        <span className="font-mono text-xs text-[var(--color-fg-500)]">/companies</span>
        <span className="text-[11px] text-[var(--color-fg-500)]">
          <span className="font-medium text-[var(--color-fg-50)]">{prospects.length}</span> total
          {Object.keys(counts).length > 0 ? " · " : ""}
          {Object.entries(counts)
            .map(([s, n]) => `${n} ${s}`)
            .slice(0, 3)
            .join(" · ")}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-900)] px-4 py-2">
        <div className="relative flex-1 max-w-sm">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-fg-500)]"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company, domain, industry, city…"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Filter className="h-3.5 w-3.5 text-[var(--color-fg-700)]" aria-hidden />
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-8 max-w-[140px] py-0 text-xs"
        >
          <option value="ALL">All statuses</option>
          <option value="needs_contact">Needs contact</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select
          value={market}
          onChange={(e) => setMarket(e.target.value)}
          className="h-8 max-w-[120px] py-0 text-xs"
        >
          <option value="ALL">All markets</option>
          <option value="CA">🇨🇦 Canada</option>
          <option value="MX">🇲🇽 Mexico</option>
          <option value="US">🇺🇸 United States</option>
          <option value="LATAM">🌎 LATAM</option>
        </Select>
        <Select
          value={icpId}
          onChange={(e) => setIcpId(e.target.value)}
          className="h-8 max-w-[180px] py-0 text-xs"
        >
          <option value="ALL">All ICPs</option>
          {icps.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
        <div className="ml-auto">
          <Select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortOption)}
            className="h-8 max-w-[160px] py-0 text-xs"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="score_desc">Score ↓</option>
            <option value="score_asc">Score ↑</option>
            <option value="name">Name A→Z</option>
          </Select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {prospects.length === 0 ? (
          <EmptyState
            icon={<Building2 className="h-8 w-8 opacity-40" />}
            title="No prospects yet"
            description="Upload a CSV or run a discovery source to seed the pipeline."
            action={
              <Link href="/discover">
                <Button variant="primary" size="sm">
                  Go to Discover
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden />
                </Button>
              </Link>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No prospects match these filters"
            description="Loosen the search or clear filters to see more."
          />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-900)] text-[10px] uppercase tracking-wider text-[var(--color-fg-700)]">
              <tr>
                <th className="px-3 py-2 font-medium w-9">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someVisibleSelected;
                    }}
                    onChange={toggleAllVisible}
                    aria-label={allVisibleSelected ? "Clear visible selection" : "Select all visible"}
                    className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-accent-300)]"
                  />
                </th>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">Industry</th>
                <th className="px-4 py-2 font-medium">Region</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Score</th>
                <th className="px-4 py-2 font-medium">ICP</th>
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const isSelected = selected.has(p.id);
                return (
                <tr
                  key={p.id}
                  onClick={() => router.push(`/companies/${p.id}` as Route)}
                  className={cn(
                    "border-b border-[var(--color-border-subtle)] cursor-pointer last:border-b-0",
                    isSelected ? "bg-[color-mix(in_oklab,var(--color-accent-300),transparent_92%)]" : "hover:bg-[var(--color-bg-800)]",
                    "focus-within:bg-[var(--color-bg-800)]",
                  )}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      router.push(`/companies/${p.id}` as Route);
                    }
                  }}
                  aria-label={`Open prospect ${p.company_name}`}
                  role="link"
                >
                  <td className="px-3 py-2 w-9" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(p.id)}
                      aria-label={isSelected ? `Deselect ${p.company_name}` : `Select ${p.company_name}`}
                      className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-accent-300)]"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-col">
                      <span className="flex items-center gap-1.5 text-[var(--color-fg-50)]">
                        <span aria-hidden>{MARKET_FLAG[p.market]}</span>
                        <span className="truncate">{p.company_name}</span>
                      </span>
                      {p.domain ? (
                        <a
                          href={p.website_url ?? `https://${p.domain}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className={cn(
                            "inline-flex w-fit items-center gap-1 font-mono text-[11px]",
                            "text-[var(--color-fg-500)] hover:text-[var(--color-accent-300)]",
                          )}
                        >
                          {p.domain}
                          <ExternalLink className="h-2.5 w-2.5" aria-hidden />
                        </a>
                      ) : null}
                    </div>
                    {p.red_flags.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {p.red_flags.map((f) => (
                          <Chip key={f} tone="warning">
                            {f.replace(/_/g, " ")}
                          </Chip>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-[11px] text-[var(--color-fg-300)]">
                    {p.industry ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-[11px] text-[var(--color-fg-500)]">
                    {[p.city, p.region].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <Chip tone={STATUS_TONE[p.status] ?? "neutral"}>{p.status}</Chip>
                      {p.pitch_status === "queued_for_approval" ? (
                        <Chip tone="warning">queued</Chip>
                      ) : p.pitch_status === "approved" ? (
                        <Chip tone="success">approved</Chip>
                      ) : p.pitch_status === "sent" ? (
                        <Chip tone="success" title="Pitch email was sent">sent</Chip>
                      ) : null}
                      {/* Reachability gate: a scored, active prospect with no email
                          can't be pitched — surface it so high fits don't look ready. */}
                      {!p.has_contact &&
                      p.match_score != null &&
                      p.status !== "suppressed" ? (
                        <Chip tone="danger" title="No contact email — can't be pitched until one is found">
                          no contact
                        </Chip>
                      ) : p.contact_is_guess ? (
                        <Chip tone="warning" title="Only contact is an unverified catch-all guess (firstname@domain) — won't bounce, but unconfirmed">
                          guess
                        </Chip>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-[11px] text-[var(--color-fg-300)]">
                    {p.match_score !== null ? p.match_score : "—"}
                  </td>
                  <td className="px-4 py-2 text-[11px] text-[var(--color-fg-500)]">
                    {p.icp_name ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-[11px] text-[var(--color-fg-500)]">
                    {p.discovery_source.replace(/_/g, " ")}
                  </td>
                  <td className="px-4 py-2 text-[11px] text-[var(--color-fg-500)]">
                    {relativeTime(p.created_at)}
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Floating bulk-action bar — appears when ≥1 row is selected */}
      {selected.size > 0 ? (
        <div
          className={cn(
            "fixed bottom-4 left-1/2 z-30 -translate-x-1/2",
            "flex items-center gap-2 rounded-[var(--radius-lg)] px-3 py-2",
            "bg-[var(--color-bg-800)] ring-1 ring-inset ring-[var(--color-accent-300)]",
            "shadow-[0_12px_32px_-12px_rgba(0,0,0,0.5)]",
          )}
          role="region"
          aria-label="Bulk actions"
        >
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-[var(--color-fg-500)] hover:bg-[var(--color-bg-700)] hover:text-[var(--color-fg-50)]"
            aria-label="Clear selection"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
          <span className="text-xs text-[var(--color-fg-50)]">
            <span className="font-medium">{selected.size}</span> selected
          </span>
          <span className="mx-1 h-4 w-px bg-[var(--color-border-default)]" aria-hidden />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={bulkPending}
            onClick={() => bulkSetStatus("researched")}
          >
            Mark researched
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={bulkPending}
            onClick={() => bulkSetStatus("pitched")}
          >
            Mark pitched
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={bulkPending}
            onClick={() => bulkSetStatus("suppressed")}
            title="Suppress with reason='manual bulk suppression'"
          >
            Suppress
          </Button>
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={bulkPending || selected.size > 20}
            onClick={bulkPipeline}
            title={selected.size > 20 ? "Pipeline caps at 20 per batch" : "Run full pipeline: scrape → research → score → enrich → pitch"}
          >
            {bulkPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            )}
            Run pipeline
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={bulkPending || selected.size > 100}
            onClick={bulkScore}
            title={selected.size > 100 ? "Score caps at 100 per batch" : "Score selected against ICP rubric"}
          >
            {bulkPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Gauge className="h-3.5 w-3.5" aria-hidden />
            )}
            Score selected
          </Button>
          <span className="mx-1 h-4 w-px bg-[var(--color-border-default)]" aria-hidden />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={bulkPending}
            onClick={() => setConfirmDeleteOpen(true)}
            title="Permanently delete selected prospects"
            className="text-[var(--color-danger-300)] hover:bg-[color-mix(in_oklab,var(--color-danger-500),transparent_88%)]"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Delete
          </Button>
          {bulkToast ? (
            <span
              className={cn(
                "ml-2 rounded-[var(--radius-sm)] px-2 py-1 text-[11px]",
                bulkToast.tone === "ok"
                  ? "bg-[color-mix(in_oklab,var(--color-success-500),transparent_85%)] text-[var(--color-success-300)]"
                  : "bg-[color-mix(in_oklab,var(--color-warning-500),transparent_85%)] text-[var(--color-warning-300)]",
              )}
            >
              {bulkToast.text}
            </span>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={`Delete ${selected.size} prospect${selected.size === 1 ? "" : "s"}?`}
        description="This permanently removes the selected prospects and all their research, scores, pitches, and contacts. This can't be undone. Prospects with a booked opportunity are skipped automatically."
        confirmLabel={`Delete ${selected.size}`}
        variant="danger"
        pending={bulkPending}
        onConfirm={bulkDelete}
      />
    </div>
  );
}
