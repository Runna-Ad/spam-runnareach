import { EmptyState } from "@/components/ui/empty-state";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-[var(--radius-xl)] bg-[var(--color-bg-800)] p-6 ring-1 ring-inset ring-[var(--color-border-default)]">
        <EmptyState
          title="Accept invitation"
          description={`Invitation token ${token.slice(0, 8)}… Accept flow wires up once Supabase auth is live.`}
        />
      </div>
    </div>
  );
}
