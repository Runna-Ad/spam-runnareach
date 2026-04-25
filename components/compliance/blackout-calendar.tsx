"use client";

import { Calendar } from "lucide-react";
import * as React from "react";
import { Chip } from "@/components/ui/chip";
import { Select } from "@/components/ui/select";
import type { BlackoutDate, Market } from "@/lib/discover/blackout";
import { cn } from "@/lib/utils";

const MARKET_LABEL: Record<Market | "ALL", string> = {
  ALL: "All markets",
  CA: "🇨🇦 Canada",
  MX: "🇲🇽 Mexico",
  US: "🇺🇸 United States",
  LATAM: "🌎 LATAM",
};

interface BlackoutCalendarProps {
  blackouts: BlackoutDate[];
}

export function BlackoutCalendar({ blackouts }: BlackoutCalendarProps) {
  const [market, setMarket] = React.useState<Market | "ALL">("ALL");

  const filtered = React.useMemo(() => {
    if (market === "ALL") return blackouts;
    return blackouts.filter((b) => b.market === market);
  }, [blackouts, market]);

  // Group by month for readability.
  const byMonth = React.useMemo(() => {
    const map = new Map<string, BlackoutDate[]>();
    for (const b of filtered) {
      const m = b.blackout_date.slice(0, 7);
      const arr = map.get(m) ?? [];
      arr.push(b);
      map.set(m, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
            Blackout calendar
          </h2>
          <p className="text-xs text-[var(--color-fg-500)]">
            Days the engine pauses sending. Stat holidays + long-weekend windows.
          </p>
        </div>
        <Select
          value={market}
          onChange={(e) => setMarket(e.target.value as Market | "ALL")}
          className="h-7 max-w-[180px] py-0 text-xs"
        >
          {(["ALL", "CA", "MX", "US", "LATAM"] as const).map((m) => (
            <option key={m} value={m}>
              {MARKET_LABEL[m]}
            </option>
          ))}
        </Select>
      </div>

      {byMonth.length === 0 ? (
        <p className="rounded-[var(--radius-lg)] bg-[var(--color-bg-800)] p-4 text-xs italic text-[var(--color-fg-500)]">
          No blackout dates configured for this market.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {byMonth.map(([month, dates]) => (
            <div
              key={month}
              className="rounded-[var(--radius-lg)] bg-[var(--color-bg-800)] p-3 ring-1 ring-inset ring-[var(--color-border-default)]"
            >
              <div className="mb-2 flex items-center gap-2">
                <Calendar className="h-3.5 w-3.5 text-[var(--color-fg-500)]" aria-hidden />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-300)]">
                  {formatMonth(month)}
                </span>
              </div>
              <ul className="flex flex-col gap-1">
                {dates.map((d) => (
                  <li
                    key={d.id}
                    className={cn(
                      "flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1 text-xs",
                      d.blackout_date === today && "bg-[var(--color-bg-700)]",
                    )}
                  >
                    <span className="w-20 font-mono text-[11px] text-[var(--color-fg-500)]">
                      {formatShortDate(d.blackout_date)}
                    </span>
                    <span className="flex-1 text-[var(--color-fg-300)]">{d.label}</span>
                    {market === "ALL" ? <Chip tone="neutral">{d.market}</Chip> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatMonth(ym: string): string {
  const [y, m] = ym.split("-");
  const date = new Date(Number.parseInt(y!, 10), Number.parseInt(m!, 10) - 1, 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function formatShortDate(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  const date = new Date(Number.parseInt(y!, 10), Number.parseInt(m!, 10) - 1, Number.parseInt(d!, 10));
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
