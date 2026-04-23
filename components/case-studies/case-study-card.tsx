"use client";

import { MessageSquareQuote } from "lucide-react";
import Image from "next/image";
import { Chip } from "@/components/ui/chip";
import { deriveCompleteness } from "@/lib/case-studies/completeness";
import type { CaseStudyWithRelations, PainTaxonomy } from "@/lib/case-studies/queries";
import { cn } from "@/lib/utils";

interface CaseStudyCardProps {
  caseStudy: CaseStudyWithRelations;
  painTaxonomy: PainTaxonomy[];
  onOpen: (id: string) => void;
}

export function CaseStudyCard({ caseStudy, painTaxonomy, onOpen }: CaseStudyCardProps) {
  const completeness = deriveCompleteness(caseStudy);
  const painMap = new Map(painTaxonomy.map((p) => [p.id, p]));
  const linkedPains = caseStudy.pain_tags
    .map((t) => painMap.get(t.pain_id))
    .filter((p): p is PainTaxonomy => Boolean(p));

  return (
    <button
      type="button"
      onClick={() => onOpen(caseStudy.id)}
      className={cn(
        "group flex flex-col gap-3 rounded-[var(--radius-lg)] p-4 text-left",
        "bg-[var(--color-bg-800)] ring-1 ring-inset ring-[var(--color-border-default)]",
        "transition-[background,box-shadow,transform]",
        "duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
        "hover:bg-[var(--color-bg-700)] hover:ring-[var(--color-border-strong)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-300)]",
      )}
      aria-label={`Edit case study: ${caseStudy.client_name}`}
    >
      <div className="flex items-start gap-3">
        <LogoOrInitials client={caseStudy.client_name} logoUrl={caseStudy.logo_url} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="truncate text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
            {caseStudy.client_name}
          </h3>
          {caseStudy.industry ? (
            <p className="truncate text-[11px] text-[var(--color-fg-500)]">{caseStudy.industry}</p>
          ) : null}
        </div>
        {completeness.hasTestimonial ? (
          <span
            className="shrink-0 text-[var(--color-accent-300)]"
            title="Case includes a client testimonial"
            aria-label="Has testimonial"
          >
            <MessageSquareQuote className="h-4 w-4" aria-hidden />
          </span>
        ) : null}
      </div>

      {caseStudy.hero_metric_en ? (
        <p className="line-clamp-2 text-[13px] font-medium leading-snug text-[var(--color-fg-300)]">
          {caseStudy.hero_metric_en}
        </p>
      ) : (
        <p className="text-[13px] italic text-[var(--color-fg-700)]">No hero metric yet</p>
      )}

      <div className="flex flex-wrap gap-1">
        {linkedPains.slice(0, 4).map((p) => (
          <Chip key={p.id} tone="neutral">
            {p.display_name_en}
          </Chip>
        ))}
        {linkedPains.length > 4 ? (
          <Chip tone="neutral">+{linkedPains.length - 4}</Chip>
        ) : null}
        {linkedPains.length === 0 ? (
          <Chip tone="neutral" className="italic opacity-60">
            no pain tags
          </Chip>
        ) : null}
      </div>

      <div className="mt-auto flex items-center gap-1 pt-1">
        <Chip tone={completeness.enComplete ? "success" : "warning"}>
          EN {completeness.enComplete ? "✓" : "partial"}
        </Chip>
        <Chip
          tone={
            completeness.esStatus === "complete"
              ? "success"
              : completeness.esStatus === "partial"
                ? "warning"
                : "danger"
          }
        >
          ES{" "}
          {completeness.esStatus === "complete"
            ? "✓"
            : completeness.esStatus === "partial"
              ? "partial"
              : "missing"}
        </Chip>
      </div>
    </button>
  );
}

function LogoOrInitials({ client, logoUrl }: { client: string; logoUrl: string | null }) {
  if (logoUrl) {
    return (
      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-[var(--radius-md)] bg-[var(--color-bg-900)] ring-1 ring-inset ring-[var(--color-border-default)]">
        <Image
          src={logoUrl}
          alt={`${client} logo`}
          fill
          sizes="40px"
          className="object-contain"
        />
      </div>
    );
  }

  const initials = deriveInitials(client);
  return (
    <div
      aria-hidden
      className={cn(
        "grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-md)]",
        "bg-[var(--color-bg-900)] ring-1 ring-inset ring-[var(--color-border-default)]",
        "font-[family-name:var(--font-display)] text-[13px] font-semibold tracking-tight",
        "text-[var(--color-accent-300)]",
      )}
    >
      {initials}
    </div>
  );
}

function deriveInitials(name: string): string {
  const cleaned = name.replace(/[^a-zA-ZÀ-ÿ\s/-]/g, " ").trim();
  const parts = cleaned.split(/[\s/-]+/).filter(Boolean);
  if (parts.length === 0) return "·";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
