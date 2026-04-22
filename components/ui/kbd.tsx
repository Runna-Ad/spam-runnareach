import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Keyboard shortcut hint. Pass children as a single key or array for combos.
 * Example: <Kbd>⌘</Kbd><Kbd>K</Kbd>
 */
export const Kbd = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <kbd
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center",
        "h-5 min-w-5 px-1",
        "rounded-[var(--radius-sm)]",
        "bg-[var(--color-bg-700)]",
        "ring-1 ring-inset ring-[var(--color-border-default)]",
        "font-mono text-[10px] text-[var(--color-fg-500)]",
        className,
      )}
      {...props}
    />
  ),
);
Kbd.displayName = "Kbd";
