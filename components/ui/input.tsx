import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-9 w-full rounded-[var(--radius-md)] bg-[var(--color-bg-900)] px-3 text-sm",
        "text-[var(--color-fg-50)] placeholder:text-[var(--color-fg-700)]",
        "ring-1 ring-inset ring-[var(--color-border-default)]",
        "transition-[box-shadow,background]",
        "duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
        "hover:ring-[var(--color-border-strong)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-300)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
