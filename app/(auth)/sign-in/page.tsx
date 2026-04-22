import { EmptyState } from "@/components/ui/empty-state";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-[var(--radius-xl)] bg-[var(--color-bg-800)] p-6 ring-1 ring-inset ring-[var(--color-border-default)]">
        <EmptyState
          title="Sign in — wired next turn"
          description="Supabase auth lands once credentials are provided. Until then, /sign-in is a placeholder."
        />
      </div>
    </div>
  );
}
