"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { acceptInviteAsNewUser, type AcceptInviteState } from "@/lib/settings/accept-invite";

interface AcceptInviteFormProps {
  token: string;
  email: string;
  role: "admin" | "reviewer" | "viewer";
  tenantName: string;
}

export function AcceptInviteForm({ token, email, role, tenantName }: AcceptInviteFormProps) {
  const [state, formAction, pending] = useActionState<AcceptInviteState, FormData>(
    acceptInviteAsNewUser,
    null,
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-lg font-semibold tracking-tight text-[var(--color-fg-50)]">
          Accept invitation
        </h1>
        <p className="mt-1 text-xs text-[var(--color-fg-500)]">
          You've been invited to join{" "}
          <span className="font-medium text-[var(--color-fg-300)]">{tenantName}</span> as a{" "}
          <Chip tone="accent">{role}</Chip>.
        </p>
      </div>

      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="token" value={token} />

        <div className="flex flex-col gap-1.5">
          <Label>Email</Label>
          <Input value={email} disabled />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="full_name">Full name</Label>
          <Input
            id="full_name"
            name="full_name"
            autoComplete="name"
            required
            placeholder="Your name"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            placeholder="At least 8 characters"
          />
        </div>

        {state && "error" in state ? (
          <p className="text-xs text-[var(--color-danger-300)]">{state.error}</p>
        ) : null}

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Creating account…" : "Accept & create account"}
        </Button>
      </form>
    </div>
  );
}
