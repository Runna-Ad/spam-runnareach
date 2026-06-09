"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AlertTriangle } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "primary";
  onConfirm: () => void | Promise<void>;
  pending?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "danger",
  onConfirm,
  pending = false,
}: ConfirmDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "runna-drawer-overlay",
            "fixed inset-0 z-40 bg-black/60 backdrop-blur-sm",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "runna-modal-content",
            "fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2",
            "rounded-[var(--radius-xl)] bg-[var(--color-bg-800)] p-5",
            "ring-1 ring-inset ring-[var(--color-border-default)] shadow-[var(--shadow-floating)]",
            "focus:outline-none",
          )}
        >
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "grid h-9 w-9 shrink-0 place-items-center rounded-full",
                variant === "danger"
                  ? "bg-[color-mix(in_oklab,var(--color-danger-500),transparent_80%)] text-[var(--color-danger-300)]"
                  : "bg-[color-mix(in_oklab,var(--color-accent-300),transparent_80%)] text-[var(--color-accent-300)]",
              )}
              aria-hidden
            >
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <DialogPrimitive.Title className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-xs text-[var(--color-fg-500)]">
                {description}
              </DialogPrimitive.Description>
            </div>
          </div>
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              {cancelLabel}
            </Button>
            <Button
              type="button"
              variant={variant === "danger" ? "danger" : "primary"}
              size="sm"
              onClick={() => {
                void onConfirm();
              }}
              disabled={pending}
            >
              {pending ? "Working…" : confirmLabel}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
