"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import {
  Building2,
  ScrollText,
  Search,
  Target,
  UserCircle2,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Kbd } from "@/components/ui/kbd";
import { loadPaletteItems, type PaletteItem } from "@/lib/command-palette/search-items";
import { cn } from "@/lib/utils";
import { NAV_SECTIONS } from "@/components/dashboard/sidebar-nav";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const GROUP_LABELS: Record<PaletteItem["group"] | "nav", string> = {
  nav: "Navigate",
  case_study: "Case studies",
  icp: "ICPs",
  member: "Team",
};

const GROUP_ICONS: Record<PaletteItem["group"] | "nav", LucideIcon> = {
  nav: Search,
  case_study: ScrollText,
  icp: Target,
  member: UserCircle2,
};

function buildNavItems(): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      items.push({
        id: `nav:${item.href}`,
        group: "nav",
        label: item.label,
        detail: section.label,
        href: item.href,
        keywords: [item.label, section.label, item.href.replace("/", "")],
      });
    }
  }
  // Add settings subpages explicitly — the sidebar only shows /settings/profile.
  items.push(
    {
      id: "nav:/settings/sending",
      group: "nav",
      label: "Sending",
      detail: "Settings",
      href: "/settings/sending",
      keywords: ["sending", "sender inbox", "gmail", "settings"],
    },
    {
      id: "nav:/settings/users",
      group: "nav",
      label: "Users",
      detail: "Settings",
      href: "/settings/users",
      keywords: ["users", "team", "invite", "teammate", "settings"],
    },
  );
  return items;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const [dynamicItems, setDynamicItems] = React.useState<PaletteItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const loadedRef = React.useRef(false);

  // Load case studies / ICPs / members the first time the palette opens.
  // Subsequent opens reuse the cached list. The palette is a short-lived
  // UI so stale-by-session is acceptable.
  React.useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    loadPaletteItems()
      .then((items) => setDynamicItems(items))
      .catch((err) => console.error("palette load failed", err))
      .finally(() => setLoading(false));
  }, [open]);

  const navItems = React.useMemo(buildNavItems, []);
  const allItems = React.useMemo(() => [...navItems, ...dynamicItems], [navItems, dynamicItems]);

  const grouped = React.useMemo(() => {
    const groups: Record<string, PaletteItem[]> = {};
    for (const item of allItems) {
      (groups[item.group] ??= []).push(item);
    }
    return groups;
  }, [allItems]);

  const handleSelect = (item: PaletteItem) => {
    onOpenChange(false);
    router.push(item.href as never);
  };

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
            "fixed left-1/2 top-[20%] z-50 w-full max-w-xl -translate-x-1/2",
            "rounded-[var(--radius-xl)] bg-[var(--color-bg-800)]",
            "ring-1 ring-inset ring-[var(--color-border-default)] shadow-[var(--shadow-floating)]",
            "focus:outline-none",
          )}
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search to navigate or act quickly.
          </DialogPrimitive.Description>
          <Command
            label="Command palette"
            className="flex flex-col"
            shouldFilter
          >
            <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3">
              <Search className="h-4 w-4 text-[var(--color-fg-500)]" aria-hidden />
              <Command.Input
                placeholder={loading ? "Loading…" : "Search or run command"}
                className={cn(
                  "flex h-11 flex-1 bg-transparent text-sm outline-none",
                  "text-[var(--color-fg-50)] placeholder:text-[var(--color-fg-500)]",
                )}
              />
              <Kbd>esc</Kbd>
            </div>
            <Command.List className="max-h-[380px] overflow-y-auto px-1.5 py-2">
              <Command.Empty className="px-3 py-6 text-center text-xs text-[var(--color-fg-500)]">
                No matches.
              </Command.Empty>

              {(["nav", "case_study", "icp", "member"] as const).map((group) => {
                const items = grouped[group];
                if (!items || items.length === 0) return null;
                const Icon = GROUP_ICONS[group];
                return (
                  <Command.Group
                    key={group}
                    heading={
                      <span className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-700)]">
                        {GROUP_LABELS[group]}
                      </span>
                    }
                  >
                    {items.map((item) => (
                      <Command.Item
                        key={item.id}
                        value={`${item.label} ${item.keywords.join(" ")}`}
                        onSelect={() => handleSelect(item)}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-sm",
                          "text-[var(--color-fg-300)]",
                          "data-[selected=true]:bg-[var(--color-bg-700)] data-[selected=true]:text-[var(--color-fg-50)]",
                        )}
                      >
                        <Icon
                          className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-500)]"
                          aria-hidden
                        />
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.detail ? (
                          <span className="truncate text-[11px] text-[var(--color-fg-700)]">
                            {item.detail}
                          </span>
                        ) : null}
                      </Command.Item>
                    ))}
                  </Command.Group>
                );
              })}
            </Command.List>
            <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-3 py-2 text-[10px] text-[var(--color-fg-700)]">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd> navigate
                </span>
                <span className="inline-flex items-center gap-1">
                  <Kbd>↵</Kbd> select
                </span>
              </div>
              <span className="inline-flex items-center gap-1">
                <Building2 className="h-3 w-3" aria-hidden /> Runna
              </span>
            </div>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
