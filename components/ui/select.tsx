import { ChevronDown } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <div className="relative">
    <select
      ref={ref}
      className={cn(
        "flex h-9 w-full appearance-none rounded-[var(--radius-md)] bg-[var(--color-bg-900)] pl-3 pr-8 text-sm",
        "text-[var(--color-fg-50)]",
        "ring-1 ring-inset ring-[var(--color-border-default)]",
        "transition-[box-shadow,background]",
        "duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
        "hover:ring-[var(--color-border-strong)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-300)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDown
      aria-hidden
      className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-fg-500)]"
    />
  </div>
));
Select.displayName = "Select";
