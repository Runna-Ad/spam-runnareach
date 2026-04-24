"use client";

import { Check, Copy, Loader2, Trash2, UserPlus, X } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  changeMemberRole,
  inviteTeammate,
  removeMember,
  revokeInvitation,
} from "@/lib/settings/users-actions";
import type { Member, PendingInvitation, UserRole } from "@/lib/settings/users-queries";
import { cn, relativeTime } from "@/lib/utils";

interface UsersPageProps {
  currentUserId: string;
  currentUserRole: UserRole;
  members: Member[];
  invitations: PendingInvitation[];
  baseUrl: string;
}

const ROLES: UserRole[] = ["admin", "reviewer", "viewer"];

export function UsersPage({
  currentUserId,
  currentUserRole,
  members,
  invitations,
  baseUrl,
}: UsersPageProps) {
  const isAdmin = currentUserRole === "admin";
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState<UserRole>("reviewer");
  const [inviteError, setInviteError] = React.useState<string | null>(null);
  const [inviteSending, startInvite] = React.useTransition();
  const [freshInviteUrl, setFreshInviteUrl] = React.useState<string | null>(null);

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    setInviteError(null);
    setFreshInviteUrl(null);
    startInvite(async () => {
      const result = await inviteTeammate({ email: inviteEmail, role: inviteRole });
      if (result.ok) {
        setFreshInviteUrl(`${baseUrl}/invite/${result.token}`);
        setInviteEmail("");
      } else {
        setInviteError(result.error);
      }
    });
  };

  return (
    <div className="flex flex-col gap-8 p-4">
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
            Invite a teammate
          </h2>
          <p className="text-xs text-[var(--color-fg-500)]">
            Invitations expire in 7 days. Email delivery isn't wired yet — copy the link and share
            it manually.
          </p>
        </div>
        {isAdmin ? (
          <form
            onSubmit={handleInvite}
            className="flex flex-col gap-3 rounded-[var(--radius-lg)] bg-[var(--color-bg-800)] p-4 ring-1 ring-inset ring-[var(--color-border-default)]"
          >
            <div className="grid grid-cols-[1fr_160px_auto] gap-2">
              <div className="flex flex-col gap-1.5">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@runna.agency"
                  required
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Role</Label>
                <Select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as UserRole)}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col justify-end">
                <Button type="submit" variant="primary" disabled={inviteSending}>
                  {inviteSending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <UserPlus className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {inviteSending ? "Sending…" : "Invite"}
                </Button>
              </div>
            </div>
            {inviteError ? (
              <p className="text-xs text-[var(--color-danger-300)]">{inviteError}</p>
            ) : null}
            {freshInviteUrl ? <InviteLinkBanner url={freshInviteUrl} /> : null}
          </form>
        ) : (
          <div className="rounded-[var(--radius-lg)] bg-[var(--color-bg-800)] p-4 ring-1 ring-inset ring-[var(--color-border-default)]">
            <p className="text-xs text-[var(--color-fg-500)]">
              Only admins can invite teammates.
            </p>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
          Members ({members.length})
        </h2>
        <div className="overflow-hidden rounded-[var(--radius-lg)] bg-[var(--color-bg-800)] ring-1 ring-inset ring-[var(--color-border-default)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-900)] text-[10px] uppercase tracking-wider text-[var(--color-fg-700)]">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Last seen</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <MemberRow
                  key={m.id}
                  member={m}
                  isSelf={m.id === currentUserId}
                  isAdmin={isAdmin}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
          Pending invitations ({invitations.length})
        </h2>
        {invitations.length === 0 ? (
          <EmptyState
            title="No pending invitations"
            description="Invited teammates show up here with a copy-link button until they accept."
          />
        ) : (
          <div className="overflow-hidden rounded-[var(--radius-lg)] bg-[var(--color-bg-800)] ring-1 ring-inset ring-[var(--color-border-default)]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-900)] text-[10px] uppercase tracking-wider text-[var(--color-fg-700)]">
                <tr>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">Invited by</th>
                  <th className="px-3 py-2 font-medium">Expires</th>
                  <th className="px-3 py-2 font-medium">Link</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => (
                  <InvitationRow key={inv.id} inv={inv} baseUrl={baseUrl} isAdmin={isAdmin} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function InviteLinkBanner({ url }: { url: string }) {
  const [copied, setCopied] = React.useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-[var(--radius-md)] p-3",
        "bg-[color-mix(in_oklab,var(--color-success-500),transparent_85%)]",
        "ring-1 ring-inset ring-[color-mix(in_oklab,var(--color-success-500),transparent_70%)]",
      )}
    >
      <Check className="h-4 w-4 shrink-0 text-[var(--color-success-300)]" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-medium text-[var(--color-success-300)]">Invitation created</span>
        <code className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-fg-300)]">
          {url}
        </code>
      </div>
      <Button type="button" size="sm" variant="secondary" onClick={copy}>
        <Copy className="h-3.5 w-3.5" aria-hidden />
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function MemberRow({
  member,
  isSelf,
  isAdmin,
}: {
  member: Member;
  isSelf: boolean;
  isAdmin: boolean;
}) {
  const [pendingRole, setPendingRole] = React.useState<UserRole | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [removing, startRemoving] = React.useTransition();
  const [changing, startChanging] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const handleRoleChange = (role: UserRole) => {
    setError(null);
    setPendingRole(role);
    startChanging(async () => {
      const result = await changeMemberRole({ userId: member.id, role });
      if (!result.ok) {
        setError(result.error);
      }
      setPendingRole(null);
    });
  };

  const handleRemove = () => {
    setError(null);
    startRemoving(async () => {
      const result = await removeMember(member.id);
      if (!result.ok) {
        setError(result.error);
      }
      setConfirmRemove(false);
    });
  };

  return (
    <>
      <tr className="border-b border-[var(--color-border-subtle)] last:border-b-0">
        <td className="px-3 py-2">
          <div className="flex flex-col">
            <span className="truncate text-[var(--color-fg-50)]">
              {member.full_name ?? "—"}
              {isSelf ? (
                <Chip tone="accent" className="ml-2">
                  you
                </Chip>
              ) : null}
            </span>
            {error ? (
              <span className="text-[11px] text-[var(--color-danger-300)]">{error}</span>
            ) : null}
          </div>
        </td>
        <td className="px-3 py-2 text-[var(--color-fg-300)]">{member.email}</td>
        <td className="px-3 py-2">
          {isAdmin ? (
            <Select
              value={pendingRole ?? member.role}
              onChange={(e) => handleRoleChange(e.target.value as UserRole)}
              disabled={changing}
              className="h-7 py-0 text-xs"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          ) : (
            <Chip tone="accent">{member.role}</Chip>
          )}
        </td>
        <td className="px-3 py-2 text-[11px] text-[var(--color-fg-500)]">
          {member.last_seen_at ? relativeTime(member.last_seen_at) : "never"}
        </td>
        <td className="px-3 py-2 text-right">
          {isAdmin && !isSelf ? (
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              className={cn(
                "grid h-7 w-7 place-items-center rounded-[var(--radius-md)]",
                "text-[var(--color-fg-500)] hover:bg-[var(--color-bg-700)] hover:text-[var(--color-danger-300)]",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-300)]",
              )}
              aria-label={`Remove ${member.email}`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </td>
      </tr>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${member.full_name ?? member.email}?`}
        description="This deletes their profile and auth account. Anything they own (pitches, notes) stays, attributed to their old email."
        confirmLabel="Remove member"
        onConfirm={handleRemove}
        pending={removing}
      />
    </>
  );
}

function InvitationRow({
  inv,
  baseUrl,
  isAdmin,
}: {
  inv: PendingInvitation;
  baseUrl: string;
  isAdmin: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const [revoking, startRevoking] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const url = `${baseUrl}/invite/${inv.token}`;

  const copy = () => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleRevoke = () => {
    setError(null);
    startRevoking(async () => {
      const result = await revokeInvitation(inv.id);
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <tr className="border-b border-[var(--color-border-subtle)] last:border-b-0">
      <td className="px-3 py-2 text-[var(--color-fg-300)]">
        {inv.email}
        {error ? (
          <div className="text-[11px] text-[var(--color-danger-300)]">{error}</div>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <Chip tone="neutral">{inv.role}</Chip>
      </td>
      <td className="px-3 py-2 text-[11px] text-[var(--color-fg-500)]">
        {inv.invited_by_name ?? "—"}
      </td>
      <td className="px-3 py-2 text-[11px] text-[var(--color-fg-500)]">
        {relativeTime(inv.expires_at)}
      </td>
      <td className="px-3 py-2">
        <Button type="button" size="sm" variant="secondary" onClick={copy}>
          <Copy className="h-3 w-3" aria-hidden />
          {copied ? "Copied" : "Copy link"}
        </Button>
      </td>
      <td className="px-3 py-2 text-right">
        {isAdmin ? (
          <button
            type="button"
            onClick={handleRevoke}
            disabled={revoking}
            className={cn(
              "grid h-7 w-7 place-items-center rounded-[var(--radius-md)]",
              "text-[var(--color-fg-500)] hover:bg-[var(--color-bg-700)] hover:text-[var(--color-danger-300)]",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-300)]",
            )}
            aria-label={`Revoke invitation for ${inv.email}`}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </td>
    </tr>
  );
}
