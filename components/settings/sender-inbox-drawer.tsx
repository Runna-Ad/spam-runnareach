"use client";

import { Loader2, Mail, Trash2 } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  createSenderInbox,
  deleteSenderInbox,
  updateSenderInbox,
} from "@/lib/settings/sending-actions";
import type { BrandLite, SenderInbox } from "@/lib/settings/sending-queries";

export type SenderDrawerMode =
  | { kind: "create" }
  | { kind: "edit"; inbox: SenderInbox };

interface SenderInboxDrawerProps {
  mode: SenderDrawerMode | null;
  brands: BrandLite[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FormState = {
  brand_instance_id: string;
  email: string;
  display_name: string;
  linkedin_url: string;
  daily_cap: string;
  paused: boolean;
  paused_reason: string;
};

const BLANK = (brandId: string): FormState => ({
  brand_instance_id: brandId,
  email: "",
  display_name: "",
  linkedin_url: "",
  daily_cap: "30",
  paused: false,
  paused_reason: "",
});

export function SenderInboxDrawer({ mode, brands, open, onOpenChange }: SenderInboxDrawerProps) {
  const firstBrand = brands[0]?.id ?? "";
  const [state, setState] = React.useState<FormState>(() => BLANK(firstBrand));
  const [error, setError] = React.useState<string | null>(null);
  const [saving, startSaving] = React.useTransition();
  const [deleting, startDeleting] = React.useTransition();
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  React.useEffect(() => {
    if (mode?.kind === "edit") {
      setState({
        brand_instance_id: mode.inbox.brand_instance_id,
        email: mode.inbox.email,
        display_name: mode.inbox.display_name,
        linkedin_url: mode.inbox.linkedin_url ?? "",
        daily_cap: String(mode.inbox.daily_cap),
        paused: mode.inbox.paused,
        paused_reason: mode.inbox.paused_reason ?? "",
      });
    } else if (mode?.kind === "create") {
      setState(BLANK(firstBrand));
    }
    setError(null);
  }, [mode, firstBrand]);

  if (!mode) return null;

  const isEdit = mode.kind === "edit";
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setState((s) => ({ ...s, [k]: v }));

  const handleSave = () => {
    setError(null);
    startSaving(async () => {
      const dailyCap = Number.parseInt(state.daily_cap, 10);
      if (!Number.isFinite(dailyCap) || dailyCap < 1) {
        setError("Daily cap must be a positive integer.");
        return;
      }

      const result = isEdit
        ? await updateSenderInbox({
            id: mode.inbox.id,
            display_name: state.display_name,
            linkedin_url: state.linkedin_url.trim() || null,
            daily_cap: dailyCap,
            paused: state.paused,
            paused_reason: state.paused_reason.trim() || null,
          })
        : await createSenderInbox({
            brand_instance_id: state.brand_instance_id,
            email: state.email,
            display_name: state.display_name,
            linkedin_url: state.linkedin_url.trim() || null,
            daily_cap: dailyCap,
          });

      if (result.ok) {
        onOpenChange(false);
      } else {
        setError(result.error);
      }
    });
  };

  const handleDelete = () => {
    if (!isEdit) return;
    startDeleting(async () => {
      const result = await deleteSenderInbox(mode.inbox.id);
      if (result.ok) {
        setConfirmDelete(false);
        onOpenChange(false);
      } else {
        setError(result.error);
        setConfirmDelete(false);
      }
    });
  };

  return (
    <>
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{isEdit ? mode.inbox.email : "New sender inbox"}</DrawerTitle>
            <DrawerDescription>
              {isEdit
                ? "Edit display name, daily cap, and paused state. Email + brand are immutable once the inbox exists."
                : "Add a mailbox this tenant can send from. Connect Gmail after saving; warming starts automatically."}
            </DrawerDescription>
          </DrawerHeader>

          <DrawerBody>
            <div className="flex flex-col gap-6">
              <Section title="Identity">
                <Field label="Brand instance">
                  <Select
                    disabled={isEdit}
                    value={state.brand_instance_id}
                    onChange={(e) => set("brand_instance_id", e.target.value)}
                  >
                    {brands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.display_name} · {b.primary_market}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Email address">
                  <Input
                    type="email"
                    disabled={isEdit}
                    value={state.email}
                    onChange={(e) => set("email", e.target.value)}
                    placeholder="pedro@runnareach.com"
                  />
                </Field>
                <Field label="Display name">
                  <Input
                    value={state.display_name}
                    onChange={(e) => set("display_name", e.target.value)}
                    placeholder="Pedro De Velasco"
                  />
                </Field>
                <Field label="LinkedIn URL">
                  <Input
                    type="url"
                    value={state.linkedin_url}
                    onChange={(e) => set("linkedin_url", e.target.value)}
                    placeholder="https://linkedin.com/in/…"
                  />
                </Field>
              </Section>

              <Section
                title="Sending"
                description="Daily cap is the hard maximum. Warming engine starts below and ramps."
              >
                <Field label="Daily cap">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={500}
                    value={state.daily_cap}
                    onChange={(e) => set("daily_cap", e.target.value)}
                  />
                </Field>
                {isEdit ? (
                  <>
                    <Field label="Paused">
                      <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-[var(--color-fg-300)]">
                        <input
                          type="checkbox"
                          checked={state.paused}
                          onChange={(e) => set("paused", e.target.checked)}
                          className="h-4 w-4 accent-[var(--color-accent-300)]"
                        />
                        Stop sending from this inbox
                      </label>
                    </Field>
                    {state.paused ? (
                      <Field label="Paused reason">
                        <Input
                          value={state.paused_reason}
                          onChange={(e) => set("paused_reason", e.target.value)}
                          placeholder="Bounce rate spike, manual hold, etc."
                        />
                      </Field>
                    ) : null}
                  </>
                ) : null}
              </Section>

              <Section
                title="Gmail OAuth"
                description="Connect this inbox to Gmail to actually send. Requires GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in .env.local."
              >
                <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-default)] bg-[var(--color-bg-900)] p-3">
                  <Mail className="h-4 w-4 text-[var(--color-fg-500)]" aria-hidden />
                  <div className="flex flex-1 flex-col">
                    {isEdit && mode.inbox.gmail_connected ? (
                      <span className="text-xs text-[var(--color-success-300)]">
                        ✓ Gmail connected — inbox can send.
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--color-fg-500)]">
                        {isEdit
                          ? "Not connected. Click to authorise Gmail access for this inbox."
                          : "Save the inbox first, then connect Gmail from the edit drawer."}
                      </span>
                    )}
                  </div>
                  {isEdit ? (
                    <Button
                      type="button"
                      size="sm"
                      variant={mode.inbox.gmail_connected ? "ghost" : "secondary"}
                      onClick={() => {
                        window.location.href = `/api/auth/google/connect?inbox_id=${mode.inbox.id}`;
                      }}
                    >
                      {mode.inbox.gmail_connected ? "Reconnect Gmail" : "Connect Gmail"}
                    </Button>
                  ) : null}
                </div>
              </Section>
            </div>
          </DrawerBody>

          <DrawerFooter>
            {error ? (
              <p className="mr-auto max-w-xs truncate text-xs text-[var(--color-danger-300)]">
                {error}
              </p>
            ) : null}
            {isEdit ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfirmDelete(true)}
                disabled={saving || deleting}
                className="mr-auto"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Delete
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create inbox"}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
      {isEdit ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title="Delete sender inbox?"
          description={`${mode.inbox.email} will be removed. Past pitches already sent from this inbox stay intact; new sends are blocked immediately.`}
          confirmLabel="Delete inbox"
          onConfirm={handleDelete}
          pending={deleting}
        />
      ) : null}
    </>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-500)]">
          {title}
        </h4>
        {description ? (
          <p className="mt-0.5 text-[11px] text-[var(--color-fg-700)]">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
