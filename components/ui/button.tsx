"use client";

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2",
    "font-medium tracking-tight whitespace-nowrap",
    "transition-[background,color,border,opacity]",
    "duration-[var(--duration-standard)] ease-[var(--ease-standard)]",
    "disabled:opacity-50 disabled:pointer-events-none",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-300)]",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--color-accent-300)] text-[var(--color-bg-900)] hover:bg-[var(--color-accent-400)]",
        secondary:
          "bg-[var(--color-bg-700)] text-[var(--color-fg-50)] ring-1 ring-inset ring-[var(--color-border-default)] hover:bg-[var(--color-bg-600)]",
        ghost: "text-[var(--color-fg-300)] hover:text-[var(--color-fg-50)] hover:bg-[var(--color-bg-700)]",
        danger:
          "bg-[var(--color-danger-500)] text-[var(--color-fg-50)] hover:bg-[var(--color-danger-300)]",
        link: "text-[var(--color-accent-300)] underline-offset-4 hover:underline p-0",
      },
      size: {
        sm: "h-7 px-2.5 text-xs rounded-[var(--radius-md)]",
        md: "h-9 px-3 text-sm rounded-[var(--radius-md)]",
        lg: "h-10 px-4 text-sm rounded-[var(--radius-lg)]",
        icon: "h-8 w-8 rounded-[var(--radius-md)]",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
