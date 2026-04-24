"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { acceptInviteAsCurrentUser } from "@/lib/settings/accept-invite";

interface SignedInAcceptPanelProps {
  email: string;
  tenantName: string;
  token: string;
}

export function SignedInAcceptPanel({ email, tenantName, token }: SignedInAcceptPanelProps) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startAccept] = React.useTransition();

  const handleAccept = () => {
    setError(null);
    startAccept(async () => {
      const result = await acceptInviteAsCurrentUser(token);
      if (result && "error" in result) setError(result.error);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-lg font-semibold tracking-tight text-[var(--color-fg-50)]">
          Join {tenantName}
        </h1>
        <p className="mt-1 text-xs text-[var(--color-fg-500)]">
          You're signed in as <span className="text-[var(--color-fg-300)]">{email}</span>. Accept to
          be added to this workspace.
        </p>
      </div>

      {error ? <p className="text-xs text-[var(--color-danger-300)]">{error}</p> : null}

      <Button type="button" variant="primary" onClick={handleAccept} disabled={pending}>
        {pending ? "Joining…" : "Accept invitation"}
      </Button>
    </div>
  );
}
