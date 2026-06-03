"use client";

import { Search } from "lucide-react";
import { useCommandPalette } from "@/components/command-palette/command-palette-provider";
import { Kbd } from "@/components/ui/kbd";

export function Topbar() {
  const { setOpen } = useCommandPalette();

  return (
    <header
      className="flex h-12 items-center gap-3 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-900)] px-4"
      role="banner"
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={[
          "flex h-8 items-center gap-2 rounded-[var(--radius-md)] px-2.5",
          "bg-[var(--color-bg-800)]",
          "ring-1 ring-inset ring-[var(--color-border-subtle)]",
          "text-sm text-[var(--color-fg-500)]",
          "hover:bg-[var(--color-bg-700)] hover:text-[var(--color-fg-50)]",
          "transition-colors duration-[var(--duration-fast)]",
          "w-72 max-w-full",
        ].join(" ")}
        aria-label="Open command palette"
      >
        <Search className="h-3.5 w-3.5" aria-hidden />
        <span className="flex-1 text-left">Search or run command</span>
        <span className="flex items-center gap-0.5">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div className="ml-auto" />
    </header>
  );
}
