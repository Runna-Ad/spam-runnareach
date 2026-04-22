import Link from "next/link";
import { AuthForm } from "@/components/auth/auth-form";
import { signUpAction } from "@/lib/supabase/actions";

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <div
            aria-hidden
            className="h-6 w-6 rounded-[var(--radius-sm)] bg-[var(--color-accent-300)]"
          />
          <span className="font-mono text-sm tracking-tight text-[var(--color-fg-50)]">
            S.P.A.M.
          </span>
        </div>

        <div className="rounded-[var(--radius-xl)] bg-[var(--color-bg-800)] p-6 ring-1 ring-inset ring-[var(--color-border-default)]">
          <h1 className="mb-1 text-lg font-semibold tracking-tight text-[var(--color-fg-50)]">
            Create account
          </h1>
          <p className="mb-5 text-xs text-[var(--color-fg-500)]">
            First account becomes admin. Later teammates will be invited from settings.
          </p>

          <AuthForm mode="sign-up" action={signUpAction} />
        </div>

        <p className="mt-4 text-center text-xs text-[var(--color-fg-500)]">
          Already have an account?{" "}
          <Link
            href="/sign-in"
            className="text-[var(--color-accent-300)] underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
