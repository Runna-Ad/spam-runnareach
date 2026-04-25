"use client";

import { Loader2, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { addDnc, removeDnc, type AddDncInput } from "@/lib/discover/dnc-actions";
import type { DncEntry, DncEntryType } from "@/lib/discover/dnc-queries";
import { cn, relativeTime } from "@/lib/utils";

const TYPE_LABELS: Record<DncEntryType, string> = {
  existing_client: "Existing client",
  competitor: "Competitor",
  runna_staff: "Rünna staff",
  friend_of_firm: "Friend of firm",
};

const TYPE_TONES: Record<DncEntryType, "info" | "warning" | "accent" | "neutral"> = {
  existing_client: "info",
  competitor: "warning",
  runna_staff: "accent",
  friend_of_firm: "neutral",
};

interface DncListProps {
  entries: DncEntry[];
  canManage: boolean;
}

export function DncList({ entries, canManage }: DncListProps) {
  const [addOpen, setAddOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState<DncEntry | null>(null);
  const [deleting, startDeleting] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const handleDelete = () => {
    if (!confirmDelete) return;
    setError(null);
    startDeleting(async () => {
      const result = await removeDnc(confirmDelete.id);
      if (result.ok) setConfirmDelete(null);
      else setError(result.error);
    });
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
            Do-not-contact
          </h2>
          <p className="text-xs text-[var(--color-fg-500)]">
            Existing clients, Rünna staff, competitors, and friends of firm. Hard-suppress at every send-time check.
          </p>
        </div>
        {canManage ? (
          <Button type="button" size="sm" variant="primary" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add entry
          </Button>
        ) : null}
      </div>

      {entries.length === 0 ? (
        <EmptyState
          title="No do-not-contact entries"
          description="Add the email, domain, or company of anyone the engine should never contact."
          action={
            canManage ? (
              <Button type="button" variant="primary" onClick={() => setAddOpen(true)}>
                <Plus className="h-3.5 w-3.5" aria-hidden /> Add entry
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-lg)] bg-[var(--color-bg-800)] ring-1 ring-inset ring-[var(--color-border-default)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-900)] text-[10px] uppercase tracking-wider text-[var(--color-fg-700)]">
              <tr>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Match</th>
                <th className="px-3 py-2 font-medium">Notes</th>
                <th className="px-3 py-2 font-medium">Added</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-[var(--color-border-subtle)] last:border-b-0">
                  <td className="px-3 py-2">
                    <Chip tone={TYPE_TONES[e.entry_type]}>{TYPE_LABELS[e.entry_type]}</Chip>
                  </td>
                  <td className="px-3 py-2 text-[var(--color-fg-300)]">
                    <div className="flex flex-col">
                      {e.email ? (
                        <span className="font-mono text-[11px]">{e.email}</span>
                      ) : null}
                      {e.domain ? (
                        <span className="font-mono text-[11px] text-[var(--color-fg-500)]">
                          {e.domain}
                        </span>
                      ) : null}
                      {e.company_name ? <span>{e.company_name}</span> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-[var(--color-fg-500)]">{e.notes ?? "—"}</td>
                  <td className="px-3 py-2 text-[11px] text-[var(--color-fg-500)]">
                    <div className="flex flex-col">
                      <span>{relativeTime(e.created_at)}</span>
                      {e.added_by_name ? (
                        <span className="text-[10px] text-[var(--color-fg-700)]">
                          {e.added_by_name}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canManage ? (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(e)}
                        className={cn(
                          "grid h-7 w-7 place-items-center rounded-[var(--radius-md)]",
                          "text-[var(--color-fg-500)] hover:bg-[var(--color-bg-700)] hover:text-[var(--color-danger-300)]",
                          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-300)]",
                        )}
                        aria-label={`Remove DNC entry`}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error ? <p className="text-xs text-[var(--color-danger-300)]">{error}</p> : null}

      <AddDncDrawer open={addOpen} onOpenChange={setAddOpen} />

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
        title="Remove DNC entry?"
        description="The engine will resume contacting matching prospects. Re-add to suppress again."
        confirmLabel="Remove"
        onConfirm={handleDelete}
        pending={deleting}
      />
    </>
  );
}

function AddDncDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [type, setType] = React.useState<DncEntryType>("existing_client");
  const [email, setEmail] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [companyName, setCompanyName] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, startSaving] = React.useTransition();

  React.useEffect(() => {
    if (open) {
      setType("existing_client");
      setEmail("");
      setDomain("");
      setCompanyName("");
      setNotes("");
      setError(null);
    }
  }, [open]);

  const handleSave = () => {
    setError(null);
    startSaving(async () => {
      const payload: AddDncInput = {
        entry_type: type,
        email: email.trim() || null,
        domain: domain.trim() || null,
        company_name: companyName.trim() || null,
        notes: notes.trim() || null,
      };
      const result = await addDnc(payload);
      if (result.ok) onOpenChange(false);
      else setError(result.error);
    });
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Add do-not-contact entry</DrawerTitle>
          <DrawerDescription>
            Provide at least one of email, domain, or company name. Match wins as soon as any field hits.
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Entry type</Label>
              <Select value={type} onChange={(e) => setType(e.target.value as DncEntryType)}>
                {(Object.keys(TYPE_LABELS) as DncEntryType[]).map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Email (optional)</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ceo@target.com"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Domain (optional)</Label>
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="target.com"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Company name (optional)</Label>
              <Input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Target Inc."
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Notes</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Why this is on the list (e.g. existing Rünna client, see Slack thread...)"
                rows={3}
              />
            </div>
          </div>
        </DrawerBody>

        <DrawerFooter>
          {error ? (
            <p className="mr-auto max-w-xs truncate text-xs text-[var(--color-danger-300)]">{error}</p>
          ) : null}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {saving ? "Saving…" : "Add to DNC"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
