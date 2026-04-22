import type * as React from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex min-h-[320px] flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="mb-1 text-[var(--color-fg-500)]" aria-hidden>
          {icon}
        </div>
      ) : null}
      <h3 className="text-sm font-medium tracking-tight text-[var(--color-fg-50)]">{title}</h3>
      {description ? (
        <p className="max-w-sm text-xs text-[var(--color-fg-500)]">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
