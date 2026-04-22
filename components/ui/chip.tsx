import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const chipVariants = cva(
  [
    "inline-flex items-center gap-1",
    "text-xs font-medium tracking-tight",
    "rounded-[var(--radius-sm)] px-1.5 py-0.5",
    "ring-1 ring-inset",
  ].join(" "),
  {
    variants: {
      tone: {
        neutral:
          "bg-[var(--color-bg-700)] text-[var(--color-fg-300)] ring-[var(--color-border-default)]",
        accent:
          "bg-[color-mix(in_oklab,var(--color-accent-300),transparent_85%)] text-[var(--color-accent-300)] ring-[color-mix(in_oklab,var(--color-accent-300),transparent_70%)]",
        success:
          "bg-[color-mix(in_oklab,var(--color-success-500),transparent_85%)] text-[var(--color-success-300)] ring-[color-mix(in_oklab,var(--color-success-500),transparent_70%)]",
        warning:
          "bg-[color-mix(in_oklab,var(--color-warning-500),transparent_85%)] text-[var(--color-warning-300)] ring-[color-mix(in_oklab,var(--color-warning-500),transparent_70%)]",
        danger:
          "bg-[color-mix(in_oklab,var(--color-danger-500),transparent_85%)] text-[var(--color-danger-300)] ring-[color-mix(in_oklab,var(--color-danger-500),transparent_70%)]",
        info:
          "bg-[color-mix(in_oklab,var(--color-info-500),transparent_85%)] text-[var(--color-info-300)] ring-[color-mix(in_oklab,var(--color-info-500),transparent_70%)]",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface ChipProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof chipVariants> {}

export const Chip = React.forwardRef<HTMLSpanElement, ChipProps>(
  ({ className, tone, ...props }, ref) => (
    <span ref={ref} className={cn(chipVariants({ tone }), className)} {...props} />
  ),
);
Chip.displayName = "Chip";
