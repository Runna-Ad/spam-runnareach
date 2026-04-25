import { BlackoutCalendar } from "@/components/compliance/blackout-calendar";
import { DncList } from "@/components/compliance/dnc-list";
import { requireUser } from "@/lib/auth";
import { listBlackouts } from "@/lib/discover/blackout";
import { listDnc } from "@/lib/discover/dnc-queries";

export const dynamic = "force-dynamic";

export default async function CompliancePage() {
  const user = await requireUser();

  const [dnc, blackouts] = await Promise.all([
    listDnc(user.tenantId),
    listBlackouts(user.tenantId),
  ]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border-subtle)] px-4">
        <span className="font-mono text-xs text-[var(--color-fg-500)]">/compliance</span>
        <span className="text-[11px] text-[var(--color-fg-500)]">
          {dnc.length} DNC entries · {blackouts.length} blackout dates
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-8 overflow-y-auto p-4">
        <DncList entries={dnc} canManage={user.role !== "viewer"} />
        <BlackoutCalendar blackouts={blackouts} />
      </div>
    </div>
  );
}
