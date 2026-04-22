import { EmptyState } from "@/components/ui/empty-state";

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-[var(--radius-xl)] bg-[var(--color-bg-800)] p-6 ring-1 ring-inset ring-[var(--color-border-default)]">
        <EmptyState
          title="Sign up — invite-only"
          description="S.P.A.M. is invite-only by design. Admin-issued invitations land once Supabase auth is wired."
        />
      </div>
    </div>
  );
}
