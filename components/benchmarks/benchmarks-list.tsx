"use client";

import { AlertTriangle, Check, ExternalLink, FlaskConical, Info } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { setBenchmarkActive } from "@/lib/benchmarks/actions";
import type { BenchmarkAdminRow } from "@/lib/benchmarks/queries";

interface Props {
  benchmarks: BenchmarkAdminRow[];
}

/**
 * The caveat is the most important thing on this card, so it is not hidden
 * behind a disclosure. Every row here is real and cited, but "cited" is not
 * "applicable" — some are US data for Canadian prospects, some are vendor
 * research with a stake in the finding, one is 15 years old. Activating without
 * reading is the failure mode this page exists to prevent.
 */
export function BenchmarksList({ benchmarks }: Props) {
  const [pending, startTransition] = React.useTransition();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const toggle = (b: BenchmarkAdminRow) => {
    setBusyId(b.id);
    startTransition(async () => {
      const res = await setBenchmarkActive({ benchmark_id: b.id, is_active: !b.is_active });
      setMsg(
        res.ok
          ? {
              tone: "ok",
              text: b.is_active
                ? "Deactivated — the composer will stop citing it."
                : "Active — the composer may now cite this in matching pitches.",
            }
          : { tone: "warn", text: res.error },
      );
      setBusyId(null);
      window.setTimeout(() => setMsg(null), 6000);
    });
  };

  const activeCount = benchmarks.filter((b) => b.is_active).length;

  if (benchmarks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-subtle)] py-16">
        <FlaskConical className="h-8 w-8 text-[var(--color-fg-700)]" aria-hidden />
        <p className="text-sm text-[var(--color-fg-500)]">
          No benchmarks yet — run the pending migrations to load them.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--color-fg-500)]">
          <span className="text-[var(--color-fg-50)]">{activeCount}</span> of {benchmarks.length}{" "}
          active. Only active rows can be cited, and only to a matching industry.
        </p>
        {msg ? (
          <p
            role="status"
            className={
              msg.tone === "ok"
                ? "text-xs text-[var(--color-success-fg)]"
                : "text-xs text-[var(--color-warning-fg)]"
            }
          >
            {msg.text}
          </p>
        ) : null}
      </div>

      <ul className="space-y-3">
        {benchmarks.map((b) => (
          <li
            key={b.id}
            className="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] p-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm text-[var(--color-fg-50)]">{b.statistic}</p>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip tone={b.is_active ? "success" : "neutral"}>
                    {b.is_active ? "Active" : "Inactive"}
                  </Chip>
                  {b.is_vendor_sourced ? <Chip tone="warning">Vendor-sourced</Chip> : null}
                  {b.market ? <Chip tone="neutral">{b.market}</Chip> : null}
                  {b.published_date ? (
                    <Chip tone="neutral">{b.published_date.slice(0, 4)}</Chip>
                  ) : null}
                </div>

                <p className="text-xs text-[var(--color-fg-500)]">
                  {b.publisher} ·{" "}
                  <a
                    href={b.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-[var(--color-fg-50)]"
                  >
                    source
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                </p>

                <p className="text-xs text-[var(--color-fg-500)]">
                  <span className="text-[var(--color-fg-700)]">Pains:</span>{" "}
                  {b.pain_codes.join(", ") || "—"}
                  {" · "}
                  <span className="text-[var(--color-fg-700)]">Industries:</span>{" "}
                  {b.industry_scope.length > 0 ? b.industry_scope.join(", ") : "all (unscoped)"}
                </p>

                {b.caveat ? (
                  <div className="flex gap-2 rounded-[var(--radius-md)] bg-[var(--color-bg-raised)] p-2.5">
                    <AlertTriangle
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning-fg)]"
                      aria-hidden
                    />
                    <p className="text-xs leading-relaxed text-[var(--color-fg-500)]">{b.caveat}</p>
                  </div>
                ) : null}
              </div>

              <Button
                type="button"
                size="sm"
                variant={b.is_active ? "secondary" : "primary"}
                disabled={pending && busyId === b.id}
                onClick={() => toggle(b)}
              >
                {b.is_active ? (
                  "Deactivate"
                ) : (
                  <>
                    <Check className="h-3.5 w-3.5" aria-hidden /> Activate
                  </>
                )}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-fg-700)]" aria-hidden />
        <p className="text-xs leading-relaxed text-[var(--color-fg-500)]">
          A benchmark sizes the prospect&apos;s problem — &ldquo;businesses like you lose X
          here&rdquo; — it never proves Rünna&apos;s results. The composer is instructed to use it
          that way, and may cite at most one per email. Any number in a pitch that matches neither
          stored evidence nor an active benchmark is held by the send gate.
        </p>
      </div>
    </div>
  );
}
