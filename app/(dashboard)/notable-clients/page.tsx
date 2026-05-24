import { NotableClientsGrid } from "@/components/notable-clients/notable-clients-grid";
import { requireUser } from "@/lib/auth";
import { listAllNotableClients } from "@/lib/notable-clients/queries";

export const dynamic = "force-dynamic";

export default async function NotableClientsPage() {
  const user = await requireUser();
  const clients = await listAllNotableClients(user.tenantId);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight text-[var(--color-fg-50)]">
          Notable Clients
        </h1>
        <p className="mt-1 text-sm text-[var(--color-fg-500)]">
          Marquee clients that anchor Tier 2 and Tier 3 pitch credibility hooks.
        </p>
      </div>

      <NotableClientsGrid clients={clients} />
    </div>
  );
}
