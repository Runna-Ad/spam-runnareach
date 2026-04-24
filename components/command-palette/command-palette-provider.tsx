"use client";

import * as React from "react";
import { CommandPalette } from "./command-palette";

interface CommandPaletteContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const Ctx = React.createContext<CommandPaletteContextValue | null>(null);

/**
 * Mounts the palette at the dashboard layout level and exposes a context
 * hook so any component (topbar button, sidebar shortcut, keyboard handler)
 * can open it. Also registers the global ⌘K / Ctrl+K listener.
 */
export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);

  const toggle = React.useCallback(() => setOpen((o) => !o), []);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isK = e.key === "k" || e.key === "K";
      if (!isK) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      // Let native browser search stay alone if user is typing in a field and
      // explicitly pressing Cmd+K with no other modifiers on Mac.
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggle]);

  const value = React.useMemo(() => ({ open, setOpen, toggle }), [open, toggle]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <CommandPalette open={open} onOpenChange={setOpen} />
    </Ctx.Provider>
  );
}

export function useCommandPalette() {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new Error("useCommandPalette must be used inside <CommandPaletteProvider>");
  }
  return ctx;
}
