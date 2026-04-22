"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ActionResult = { error: string } | { success: true } | null;

interface AuthFormProps {
  mode: "sign-in" | "sign-up";
  action: (prev: ActionResult, formData: FormData) => Promise<ActionResult>;
}

/**
 * Shared sign-in / sign-up form. Uses useActionState for React 19 server
 * actions with inline error display.
 */
export function AuthForm({ mode, action }: AuthFormProps) {
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(action, null);

  const isSignUp = mode === "sign-up";
  const error = state && "error" in state ? state.error : null;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {isSignUp ? (
        <Field
          label="Full name"
          name="fullName"
          type="text"
          autoComplete="name"
          placeholder="First Last"
          required
        />
      ) : null}

      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@runna.agency"
        required
      />

      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete={isSignUp ? "new-password" : "current-password"}
        placeholder={isSignUp ? "At least 8 characters" : "••••••••"}
        required
      />

      {error ? (
        <div
          role="alert"
          className="rounded-[var(--radius-md)] bg-[color-mix(in_oklab,var(--color-danger-500),transparent_85%)] px-3 py-2 text-xs text-[var(--color-danger-300)] ring-1 ring-inset ring-[color-mix(in_oklab,var(--color-danger-500),transparent_70%)]"
        >
          {error}
        </div>
      ) : null}

      <Button type="submit" variant="primary" size="md" disabled={pending} className="mt-1">
        {pending
          ? isSignUp
            ? "Creating account…"
            : "Signing in…"
          : isSignUp
            ? "Create account"
            : "Sign in"}
      </Button>
    </form>
  );
}

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  name: string;
}

function Field({ label, name, className, ...inputProps }: FieldProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-[var(--color-fg-300)]">{label}</span>
      <input
        name={name}
        className={cn(
          "h-9 rounded-[var(--radius-md)] bg-[var(--color-bg-900)] px-3 text-sm",
          "text-[var(--color-fg-50)] placeholder:text-[var(--color-fg-700)]",
          "ring-1 ring-inset ring-[var(--color-border-default)]",
          "focus:outline-none focus:ring-[var(--color-accent-300)]",
          "transition-shadow duration-[var(--duration-standard)] ease-[var(--ease-standard)]",
          className,
        )}
        {...inputProps}
      />
    </label>
  );
}
