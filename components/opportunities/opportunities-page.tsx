"use client";

import type { HunterAnalytics, HunterScan } from "@/lib/hunter/types";
import { HunterAnalytics as HunterAnalyticsPanel } from "./hunter-analytics";
import { HunterLeadsList } from "./hunter-leads-list";

interface Props {
  scans: HunterScan[];
  total: number;
  analytics: HunterAnalytics;
}

export function OpportunitiesPage({ scans, total, analytics }: Props) {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold text-[var(--color-fg-50)]">Opportunities</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-500)]">
          Inbound leads from the Inefficiency Hunter — self-identified pain, ready to pitch.
        </p>
      </div>

      {/* Analytics */}
      <HunterAnalyticsPanel analytics={analytics} />

      {/* Leads list */}
      <div>
        <h2 className="mb-3 text-sm font-medium text-[var(--color-fg-300)]">All Scans</h2>
        <HunterLeadsList initialScans={scans} total={total} />
      </div>
    </div>
  );
}
