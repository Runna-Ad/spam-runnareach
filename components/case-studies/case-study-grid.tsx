"use client";

import * as React from "react";
import { CaseStudyCard } from "./case-study-card";
import { CaseStudyEditDrawer } from "./case-study-edit-drawer";
import type {
  CaseStudyWithRelations,
  PainTaxonomy,
  ServiceLite,
} from "@/lib/case-studies/queries";
import { deriveCompleteness } from "@/lib/case-studies/completeness";

interface CaseStudyGridProps {
  caseStudies: CaseStudyWithRelations[];
  painTaxonomy: PainTaxonomy[];
  services: ServiceLite[];
}

export function CaseStudyGrid({ caseStudies, painTaxonomy, services }: CaseStudyGridProps) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const selected = React.useMemo(
    () => caseStudies.find((cs) => cs.id === selectedId) ?? null,
    [caseStudies, selectedId],
  );

  const stats = React.useMemo(() => {
    let enComplete = 0;
    let esComplete = 0;
    let esMissing = 0;
    for (const cs of caseStudies) {
      const c = deriveCompleteness(cs);
      if (c.enComplete) enComplete++;
      if (c.esStatus === "complete") esComplete++;
      if (c.esStatus === "missing") esMissing++;
    }
    return { enComplete, esComplete, esMissing, total: caseStudies.length };
  }, [caseStudies]);

  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4 text-[11px] tracking-tight">
        <span className="font-mono text-xs text-[var(--color-fg-500)]">/case-studies</span>
        <span className="mx-1 text-[var(--color-fg-700)]">·</span>
        <span className="text-[var(--color-fg-500)]">
          <span className="font-medium text-[var(--color-fg-50)]">{stats.total}</span> active
        </span>
        <span className="mx-1 text-[var(--color-fg-700)]">·</span>
        <span className="text-[var(--color-fg-500)]">
          <span className="font-medium text-[var(--color-success-300)]">{stats.enComplete}</span>{" "}
          EN complete
        </span>
        <span className="mx-1 text-[var(--color-fg-700)]">·</span>
        <span className="text-[var(--color-fg-500)]">
          <span className="font-medium text-[var(--color-danger-300)]">{stats.esMissing}</span> ES
          missing
        </span>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {caseStudies.map((cs) => (
            <CaseStudyCard
              key={cs.id}
              caseStudy={cs}
              painTaxonomy={painTaxonomy}
              onOpen={setSelectedId}
            />
          ))}
        </div>
      </div>

      <CaseStudyEditDrawer
        caseStudy={selected}
        painTaxonomy={painTaxonomy}
        services={services}
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      />
    </>
  );
}
