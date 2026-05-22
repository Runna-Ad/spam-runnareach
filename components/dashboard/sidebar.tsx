"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { NAV_SECTIONS } from "./sidebar-nav";

interface SidebarProps {
  /** Rendered in the sidebar footer. Typically <UserMenu user={...} />. */
  footerSlot?: ReactNode;
}

export function Sidebar({ footerSlot }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      className={cn(
        "hidden md:flex md:flex-col",
        "w-[232px] shrink-0",
        "border-r border-[var(--color-border-subtle)]",
        "bg-[var(--color-bg-900)]",
      )}
      aria-label="Primary navigation"
    >
      {/* Brand */}
      <div className="flex h-14 items-center gap-2 px-3.5">
        <Image
          src="/logo.png"
          alt="Runna"
          width={28}
          height={28}
          className="h-7 w-7 object-contain"
          priority
        />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="font-[family-name:var(--font-display)] text-[13px] font-semibold tracking-tight text-[var(--color-fg-50)]">
            Runna
          </span>
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--color-fg-500)]">
            S.P.A.M.
          </span>
        </div>
        <span className="ml-auto">
          <Kbd>⌘</Kbd>
          <Kbd className="ml-0.5">\</Kbd>
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label} className="mb-5 last:mb-0">
            <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-700)]">
              {section.label}
            </div>
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href as never}
                      className={cn(
                        "flex h-8 items-center gap-2.5 rounded-[var(--radius-md)] px-2 text-sm",
                        "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                        active
                          ? "bg-[var(--color-bg-700)] text-[var(--color-fg-50)]"
                          : "text-[var(--color-fg-300)] hover:bg-[var(--color-bg-800)] hover:text-[var(--color-fg-50)]",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-[var(--color-border-subtle)] p-3">{footerSlot}</div>
    </aside>
  );
}
