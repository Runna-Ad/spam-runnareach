import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Search,
  Send,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActivityCollapsible } from "@/components/dashboard/activity-collapsible";
import { Chip } from "@/components/ui/chip";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  countAddedThisWeek,
  countScrapedThisWeek,
  getAttentionQueue,
  getRecentProspects,
  getStatusCounts,
  listTenantActivity,
  type AttentionRow,
  type RecentProspect,
} from "@/lib/today/queries";
import { cn, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

const MARKET_FLAG: Record<"CA" | "MX" | "US" | "LATAM", string> = {
  CA: "🇨🇦",
  MX: "🇲🇽",
  US: "🇺🇸",
  LATAM: "🌎",
};

// Pipeline strip — every status, in flow order. Counts default to 0 if the
// tenant has no prospects in that bucket yet.
// Each stage has a distinct accent color to convey progression.
const PIPELINE_STAGES: { key: string; label: string; color: string; glowColor: string }[] = [
  { key: "raw",        label: "Raw",        color: "var(--color-fg-500)",     glowColor: "rgb(245 243 250 / 0.08)" },
  { key: "researched", label: "Researched", color: "var(--color-info-300)",   glowColor: "rgb(139 92 246 / 0.12)" },
  { key: "pitched",    label: "Pitched",    color: "var(--color-accent-300)", glowColor: "rgb(119 92 191 / 0.12)" },
  { key: "replied",    label: "Replied",    color: "var(--color-brand-gold)", glowColor: "rgb(251 174 66 / 0.12)" },
  { key: "booked",     label: "Booked",     color: "var(--color-brand-pink)", glowColor: "rgb(222 90 95 / 0.12)" },
  { key: "won",        label: "Won",        color: "var(--color-success-300)",glowColor: "rgb(74 222 128 / 0.12)" },
  { key: "lost",       label: "Lost",       color: "var(--color-fg-700)",     glowColor: "transparent" },
];

export default async function TodayPage() {
  const user = await requireUser();
  const supabase = await createClient();

  // Run everything in parallel — RLS handles tenant scoping.
  const [
    statusCounts,
    attentionQueue,
    recentProspects,
    addedThisWeek,
    scrapedThisWeek,
    icpCount,
    tenantActivity,
  ] = await Promise.all([
    getStatusCounts(user.tenantId),
    getAttentionQueue(user.tenantId),
    getRecentProspects(user.tenantId),
    countAddedThisWeek(user.tenantId),
    countScrapedThisWeek(user.tenantId),
    supabase
      .from("icps")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", user.tenantId)
      .eq("is_active", true),
    listTenantActivity(user.tenantId, 15),
  ]);

  const totalProspects = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const rawCount = statusCounts.raw ?? 0;
  const researchedCount = statusCounts.researched ?? 0;
  const activeIcps = icpCount.count ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      {/* Greeting */}
      <div>
        <p className="font-mono text-xs tracking-wider text-[var(--color-fg-500)]">
          TODAY ·{" "}
          {new Date().toLocaleDateString("en-CA", {
            weekday: "long",
            month: "short",
            day: "numeric",
          })}
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-[var(--color-fg-50)]">
          {greeting()},{" "}
          {(() => {
            const first = user.fullName?.split(" ")[0];
            return first
              ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
              : "there";
          })()}.
        </h1>
        <p className="mt-1 text-sm text-[var(--color-fg-500)]">
          {totalProspects === 0
            ? `${user.tenantDisplayName} · No prospects yet — start at /discover.`
            : `${totalProspects} prospects in pipeline · ${activeIcps} active ICP${activeIcps === 1 ? "" : "s"}.`}
        </p>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="In pipeline"
          value={totalProspects}
          icon={Sparkles}
          accent={false}
        />
        <StatTile
          label="Raw · need research"
          value={rawCount}
          icon={Search}
          accent={rawCount > 0}
          href="/companies?status=raw"
        />
        <StatTile
          label="Ready to pitch"
          value={researchedCount}
          icon={Send}
          accent={researchedCount > 0}
          href="/companies?status=researched"
        />
        <StatTile
          label="Added this week"
          value={addedThisWeek}
          icon={Clock}
          accent={false}
          subtitle={
            scrapedThisWeek > 0 ? `${scrapedThisWeek} scraped` : undefined
          }
        />
      </div>

      {/* Pipeline strip */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Pipeline at a glance</CardTitle>
          <Link
            href="/funnel"
            className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-500)] hover:text-[var(--color-accent-300)]"
          >
            Open funnel
            <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-7 gap-2">
            {PIPELINE_STAGES.map((s) => {
              const n = statusCounts[s.key] ?? 0;
              const empty = n === 0;
              return (
                <Link
                  key={s.key}
                  href={`/companies?status=${s.key}` as never}
                  style={
                    !empty
                      ? {
                          backgroundColor: s.glowColor,
                          boxShadow: `inset 0 1px 0 0 ${s.glowColor}`,
                        }
                      : undefined
                  }
                  className={cn(
                    "group flex flex-col gap-1 rounded-[var(--radius-md)] px-2 py-2.5",
                    "transition-[background,box-shadow,opacity] duration-[var(--duration-standard)]",
                    "ring-1 ring-inset",
                    empty
                      ? "bg-[var(--color-bg-900)] ring-[var(--color-border-subtle)] hover:ring-[var(--color-border-default)]"
                      : "ring-[var(--color-border-default)] hover:ring-[var(--color-border-strong)] hover:brightness-110",
                  )}
                >
                  <span
                    className="font-mono text-xl font-semibold tracking-tight transition-colors"
                    style={{ color: empty ? "var(--color-fg-700)" : s.color }}
                  >
                    {n}
                  </span>
                  <span
                    className="text-[10px] uppercase tracking-wider transition-colors"
                    style={{ color: empty ? "var(--color-fg-700)" : "var(--color-fg-500)" }}
                  >
                    {s.label}
                  </span>
                </Link>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Attention + Recent — two columns on desktop, stacked on mobile */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Needs your attention</CardTitle>
            <Chip tone={attentionQueue.length > 0 ? "warning" : "neutral"}>
              {attentionQueue.length}
            </Chip>
          </CardHeader>
          <CardContent>
            {attentionQueue.length === 0 ? (
              <div className="flex items-center gap-2 py-4 text-xs text-[var(--color-fg-500)]">
                <CheckCircle2
                  className="h-4 w-4 text-[var(--color-success-300)]"
                  aria-hidden
                />
                Inbox zero. {totalProspects === 0 ? "Seed prospects at /discover." : "Nothing rotting."}
              </div>
            ) : (
              <ul className="divide-y divide-[var(--color-border-subtle)]">
                {attentionQueue.map((row) => (
                  <AttentionRowItem key={row.id} row={row} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recently added</CardTitle>
          </CardHeader>
          <CardContent>
            {recentProspects.length === 0 ? (
              <p className="py-4 text-xs italic text-[var(--color-fg-700)]">
                Nothing yet. Upload a CSV at <Link className="underline" href="/discover">/discover</Link>.
              </p>
            ) : (
              <ul className="space-y-2">
                {recentProspects.map((p) => (
                  <RecentRow key={p.id} prospect={p} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tenant-wide activity feed — collapsible to save space */}
      <ActivityCollapsible entries={tenantActivity} />
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

interface StatTileProps {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  accent: boolean;
  href?: string;
  subtitle?: string;
}

function StatTile({ label, value, icon: Icon, accent, href, subtitle }: StatTileProps) {
  const hasValue = value > 0;
  const inner = (
    <CardContent
      className={cn(
        "flex items-center gap-3 p-4 transition-[background]",
        accent && hasValue && "bg-[color-mix(in_oklab,var(--color-accent-300),transparent_94%)]",
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)]",
          accent && hasValue
            ? "bg-[color-mix(in_oklab,var(--color-accent-300),transparent_75%)] text-[var(--color-accent-300)]"
            : "bg-[var(--color-bg-700)] text-[var(--color-fg-500)]",
        )}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </div>
      <div className="min-w-0">
        <div
          className={cn(
            "font-mono text-2xl font-semibold tracking-tight",
            hasValue ? "text-[var(--color-fg-50)]" : "text-[var(--color-fg-700)]",
          )}
        >
          {value}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-500)]">
          {label}
        </div>
        {subtitle ? (
          <div className="mt-0.5 text-[10px] text-[var(--color-fg-700)]">{subtitle}</div>
        ) : null}
      </div>
    </CardContent>
  );
  if (href) {
    return (
      // Typed-routes can't statically prove dynamic ?status=… params, so we
      // cast. Link still validates at runtime.
      <Link href={href as never} className="group">
        <Card
          className={cn(
            "transition-[box-shadow] group-hover:ring-[var(--color-border-strong)]",
            accent && hasValue && "ring-[color-mix(in_oklab,var(--color-accent-300),transparent_60%)] group-hover:ring-[var(--color-accent-300)]",
          )}
        >
          {inner}
        </Card>
      </Link>
    );
  }
  return <Card>{inner}</Card>;
}

const REASON_LABEL: Record<AttentionRow["reason"], string> = {
  ready_to_pitch: "Ready to pitch",
  needs_research: "Needs research",
  stale_research: "Stale research",
};

const REASON_TONE: Record<AttentionRow["reason"], "success" | "warning" | "info"> = {
  ready_to_pitch: "success",
  needs_research: "warning",
  stale_research: "info",
};

function AttentionRowItem({ row }: { row: AttentionRow }) {
  return (
    <li>
      <Link
        href={`/companies/${row.id}` as never}
        className={cn(
          "flex items-center gap-3 px-1 py-2.5 transition-colors",
          "hover:bg-[var(--color-bg-700)] rounded-[var(--radius-sm)]",
        )}
      >
        <Chip tone={REASON_TONE[row.reason]} className="shrink-0">
          {REASON_LABEL[row.reason]}
        </Chip>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span aria-hidden>{MARKET_FLAG[row.market]}</span>
            <span className="truncate text-sm text-[var(--color-fg-50)]">
              {row.company_name}
            </span>
            {row.match_score !== null ? (
              <span className="font-mono text-[10px] text-[var(--color-fg-500)]">
                · {row.match_score}
              </span>
            ) : null}
          </div>
          {row.domain ? (
            <div className="font-mono text-[11px] text-[var(--color-fg-500)]">
              {row.domain}
            </div>
          ) : null}
        </div>
        <span className="shrink-0 text-[11px] text-[var(--color-fg-700)]">
          {row.age_days === 0 ? "today" : `${row.age_days}d`}
        </span>
      </Link>
    </li>
  );
}

function RecentRow({ prospect }: { prospect: RecentProspect }) {
  return (
    <li>
      <Link
        href={`/companies/${prospect.id}` as never}
        className="flex flex-col rounded-[var(--radius-sm)] px-1 py-1.5 hover:bg-[var(--color-bg-700)]"
      >
        <span className="flex items-center gap-1.5 text-sm text-[var(--color-fg-50)]">
          <span aria-hidden>{MARKET_FLAG[prospect.market]}</span>
          <span className="truncate">{prospect.company_name}</span>
        </span>
        <span className="text-[11px] text-[var(--color-fg-500)]">
          {prospect.discovery_source.replace(/_/g, " ")} · {relativeTime(prospect.created_at)}
        </span>
      </Link>
    </li>
  );
}

// ActivityIcon and ActivityRow have moved to components/dashboard/activity-collapsible.tsx
