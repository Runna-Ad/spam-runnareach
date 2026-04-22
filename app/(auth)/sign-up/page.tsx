import Image from "next/image";
import Link from "next/link";
import { AuthForm } from "@/components/auth/auth-form";
import { signUpAction } from "@/lib/supabase/actions";

export default function SignUpPage() {
  return (
    <div
      className="flex min-h-screen items-center justify-center p-6"
      style={{
        backgroundImage:
          "radial-gradient(ellipse at 30% 30%, rgb(119 92 191 / 0.12) 0%, transparent 50%), radial-gradient(ellipse at 70% 70%, rgb(222 90 95 / 0.08) 0%, transparent 50%), radial-gradient(ellipse at 50% 50%, rgb(251 174 66 / 0.05) 0%, transparent 60%)",
      }}
    >
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Image
            src="/logo.png"
            alt="Runna"
            width={56}
            height={56}
            className="h-14 w-14 object-contain drop-shadow-[0_0_40px_rgb(119_92_191_/_0.25)]"
            priority
          />
          <div className="flex flex-col items-center">
            <span className="font-[family-name:var(--font-display)] text-xl font-semibold tracking-tight text-[var(--color-fg-50)]">
              Runna CA
            </span>
            <span className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--color-fg-500)]">
              S.P.A.M.
            </span>
          </div>
        </div>

        <div className="rounded-[var(--radius-xl)] bg-[var(--color-bg-800)] p-6 ring-1 ring-inset ring-[var(--color-border-default)]">
          <h1 className="mb-1 font-[family-name:var(--font-display)] text-lg font-semibold tracking-tight text-[var(--color-fg-50)]">
            Create account
          </h1>
          <p className="mb-5 text-xs text-[var(--color-fg-500)]">
            Open to @runna.com.mx, @runna.agency, and @runnareach.com emails. First account becomes admin.
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
