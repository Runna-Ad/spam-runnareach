import type { ReactNode } from "react";
import { CommandPaletteProvider } from "@/components/command-palette/command-palette-provider";
import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Topbar } from "@/components/dashboard/topbar";
import { UserMenu } from "@/components/dashboard/user-menu";
import { getCurrentUser } from "@/lib/auth";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();

  // If the user is signed in but has no public.users row yet, show a
  // clear message instead of crashing. Middleware handles the fully-
  // unauthenticated case (redirects to /sign-in).
  if (!user) {
    return (
      <div className="flex min-h-screen">
        <main className="flex-1">
          <PhasePlaceholder
            route="/dashboard"
            phase={0}
            title="Profile not provisioned"
            description="Your auth account exists but there's no Runna CA profile yet. Contact an admin or try signing out and back in."
          />
        </main>
      </div>
    );
  }

  return (
    <CommandPaletteProvider>
      <div className="flex min-h-screen">
        <Sidebar footerSlot={<UserMenu user={user} />} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
    </CommandPaletteProvider>
  );
}
