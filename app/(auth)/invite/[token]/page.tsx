import Image from "next/image";
import { AcceptInviteForm } from "@/components/auth/accept-invite-form";
import { SignedInAcceptPanel } from "@/components/auth/signed-in-accept-panel";
import { EmptyState } from "@/components/ui/empty-state";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";

type InvitationRow = {
  id: string;
  tenant_id: string;
  email: string;
  role: "admin" | "reviewer" | "viewer";
  expires_at: string;
  accepted_at: string | null;
  tenants: { display_name: string } | null;
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const admin = createServiceRoleClient();
  const { data: invitation } = await admin
    .from("invitations")
    .select("id, tenant_id, email, role, expires_at, accepted_at, tenants(display_name)")
    .eq("token", token)
    .maybeSingle<InvitationRow>();

  const invalidReason = validateInvitation(invitation);

  if (invalidReason) {
    return <InviteShell><InvalidInvite reason={invalidReason} /></InviteShell>;
  }

  // Invitation is valid. Check whether the visitor is already signed in.
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (authUser) {
    // Signed in as the same email → accept server-side + bounce to dashboard.
    // Signed in as a different email → show a polite message.
    if (authUser.email?.toLowerCase() === invitation!.email) {
      // We can't call a "use server" action directly here (it redirects),
      // so point the user at a form button that does the work.
      return (
        <InviteShell>
          <SignedInAcceptPanel
            email={invitation!.email}
            tenantName={invitation!.tenants?.display_name ?? "this tenant"}
            token={token}
          />
        </InviteShell>
      );
    }

    return (
      <InviteShell>
        <EmptyState
          title="Wrong account"
          description={`You're signed in as ${authUser.email}. This invitation is for ${invitation!.email}. Sign out, then reopen this link.`}
        />
      </InviteShell>
    );
  }

  // Unauthenticated visitor → show the accept-invite form (email prefilled).
  return (
    <InviteShell>
      <AcceptInviteForm
        token={token}
        email={invitation!.email}
        role={invitation!.role}
        tenantName={invitation!.tenants?.display_name ?? "this tenant"}
      />
    </InviteShell>
  );
}

function validateInvitation(inv: InvitationRow | null): string | null {
  if (!inv) return "Invitation not found. The link may be wrong or revoked.";
  if (inv.accepted_at) return "This invitation was already accepted.";
  if (new Date(inv.expires_at) < new Date()) return "This invitation has expired.";
  return null;
}

function InviteShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex min-h-screen items-center justify-center p-6"
      style={{
        backgroundImage:
          "radial-gradient(ellipse at 30% 30%, rgb(119 92 191 / 0.12) 0%, transparent 50%), radial-gradient(ellipse at 70% 70%, rgb(222 90 95 / 0.08) 0%, transparent 50%)",
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
              Runna
            </span>
            <span className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--color-fg-500)]">
              S.P.A.M.
            </span>
          </div>
        </div>
        <div className="rounded-[var(--radius-xl)] bg-[var(--color-bg-800)] p-6 ring-1 ring-inset ring-[var(--color-border-default)]">
          {children}
        </div>
      </div>
    </div>
  );
}

function InvalidInvite({ reason }: { reason: string }) {
  return (
    <EmptyState
      title="Invitation unavailable"
      description={reason}
      action={
        <a
          href="/sign-in"
          className="text-[var(--color-accent-300)] underline-offset-4 hover:underline"
        >
          Back to sign in
        </a>
      }
    />
  );
}

