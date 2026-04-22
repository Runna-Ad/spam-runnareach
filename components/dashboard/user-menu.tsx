import { LogOut } from "lucide-react";
import { signOutAction } from "@/lib/supabase/actions";
import type { CurrentUser } from "@/lib/auth";

interface UserMenuProps {
  user: CurrentUser;
}

/**
 * Sidebar footer: user identity + sign-out. Server component — sign-out
 * is a server action invoked via form submission.
 */
export function UserMenu({ user }: UserMenuProps) {
  const initials = (user.fullName ?? user.email)
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s.charAt(0).toUpperCase())
    .join("");

  const roleLabel =
    user.role === "admin" ? "Admin" : user.role === "reviewer" ? "Reviewer" : "Viewer";

  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-bg-800)] px-2 py-1.5 ring-1 ring-inset ring-[var(--color-border-subtle)]">
      <div
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-700)] text-[10px] font-medium text-[var(--color-fg-300)]"
        aria-hidden
      >
        {initials || "··"}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-[var(--color-fg-50)]">
          {user.fullName ?? user.email}
        </div>
        <div className="truncate font-mono text-[10px] text-[var(--color-fg-500)]">
          {roleLabel} · {user.tenantDisplayName}
        </div>
      </div>
      <form action={signOutAction}>
        <button
          type="submit"
          className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-fg-500)] transition-colors hover:bg-[var(--color-bg-700)] hover:text-[var(--color-fg-50)]"
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden />
        </button>
      </form>
    </div>
  );
}
