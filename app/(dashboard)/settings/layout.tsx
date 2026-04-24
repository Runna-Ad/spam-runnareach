import type { ReactNode } from "react";
import { SettingsTabs } from "@/components/settings/settings-tabs";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-4 border-b border-[var(--color-border-subtle)] px-4">
        <span className="font-mono text-xs text-[var(--color-fg-500)]">/settings</span>
        <SettingsTabs />
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
