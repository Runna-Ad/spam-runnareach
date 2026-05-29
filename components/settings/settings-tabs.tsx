"use client";

import { Send, User, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/settings/profile", label: "Profile", icon: User },
  { href: "/settings/sending", label: "Sending", icon: Send },
  { href: "/settings/users", label: "Users", icon: Users },
] as const;

export function SettingsTabs() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-4" aria-label="Settings sections">
      {TABS.map((t) => {
        const Icon = t.icon;
        const active = pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "inline-flex h-11 items-center gap-1.5 border-b-2 px-0.5 text-[11px] font-medium tracking-tight",
              "-mb-px transition-[color,border-color]",
              "duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
              active
                ? "border-[var(--color-accent-300)] text-[var(--color-fg-50)]"
                : "border-transparent text-[var(--color-fg-500)] hover:text-[var(--color-fg-50)]",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
