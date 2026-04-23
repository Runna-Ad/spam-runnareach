import * as React from "react";
import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-[72px] w-full rounded-[var(--radius-md)] bg-[var(--color-bg-900)] px-3 py-2 text-sm",
      "text-[var(--color-fg-50)] placeholder:text-[var(--color-fg-700)]",
      "ring-1 ring-inset ring-[var(--color-border-default)]",
      "transition-[box-shadow,background]",
      "duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
      "hover:ring-[var(--color-border-strong)]",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-300)]",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "resize-y",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
