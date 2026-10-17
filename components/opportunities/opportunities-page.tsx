"use client";

import type { HunterAnalytics, HunterScan } from "@/lib/hunter/types";
import { HunterAnalytics as HunterAnalyticsPanel } from "./hunter-analytics";
import type { OpportunityRow } from "@/lib/opportunities/queries";
import { HunterLeadsList } from "./hunter-leads-list";
import { PipelineList } from "./pipeline-list";

interface Props {
  scans: HunterScan[];
  total: number;
  analytics: HunterAnalytics;
  opportunities: OpportunityRow[];
}

export function OpportunitiesPage({ scans, total, analytics, opportunities }: Props) {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold text-[var(--color-fg-50)]">Opportunities</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-500)]">
          Inbound leads from the Inefficiency Hunter — self-identified pain, ready to pitch.
        </p>
      </div>

      {/* Pipeline */}
      <div>
        <h2 className="mb-3 text-sm font-medium text-[var(--color-fg-300)]">Pipeline</h2>
        <PipelineList opportunities={opportunities} />
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
