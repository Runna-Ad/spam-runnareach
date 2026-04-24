"use client";

import { Loader2 } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { updateProfile } from "@/lib/settings/profile-actions";
import { COMMON_TIMEZONES, isCommonTimezone } from "@/lib/settings/timezones";
import { cn } from "@/lib/utils";

interface ProfileFormProps {
  user: {
    id: string;
    email: string;
    role: "admin" | "reviewer" | "viewer";
    fullName: string | null;
    avatarUrl: string | null;
    tenantDisplayName: string;
    timezone: string;
  };
}

export function ProfileForm({ user }: ProfileFormProps) {
  const [fullName, setFullName] = React.useState(user.fullName ?? "");
  const [avatarUrl, setAvatarUrl] = React.useState(user.avatarUrl ?? "");
  const [tzValue, setTzValue] = React.useState(
    isCommonTimezone(user.timezone) ? user.timezone : "__other__",
  );
  const [tzCustom, setTzCustom] = React.useState(
    isCommonTimezone(user.timezone) ? "" : user.timezone,
  );
  const [status, setStatus] = React.useState<"idle" | "saved" | { error: string }>("idle");
  const [saving, start] = React.useTransition();

  const effectiveTz = tzValue === "__other__" ? tzCustom.trim() : tzValue;

  const handleSave = () => {
    setStatus("idle");
    start(async () => {
      const result = await updateProfile({
        full_name: fullName,
        timezone: effectiveTz,
        avatar_url: avatarUrl.trim().length > 0 ? avatarUrl.trim() : null,
      });
      if (result.ok) {
        setStatus("saved");
        setTimeout(() => setStatus("idle"), 2500);
      } else {
        setStatus({ error: result.error });
      }
    });
  };

  return (
    <div className="flex max-w-2xl flex-col gap-6 p-4">
      <header className="flex items-center gap-4">
        <Avatar url={avatarUrl} name={fullName || user.email} />
        <div className="flex flex-col">
          <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
            {fullName || user.email}
          </h2>
          <span className="text-xs text-[var(--color-fg-500)]">{user.email}</span>
          <div className="mt-1 flex items-center gap-1.5">
            <Chip tone="accent">{user.role}</Chip>
            <Chip tone="neutral">{user.tenantDisplayName}</Chip>
          </div>
        </div>
      </header>

      <Section title="Display">
        <Field label="Full name">
          <Input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Pedro De Velasco"
            autoComplete="name"
          />
        </Field>
        <Field label="Avatar URL">
          <Input
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            placeholder="https://…/avatar.jpg"
            type="url"
          />
        </Field>
      </Section>

      <Section title="Locale">
        <Field label="Timezone">
          <Select value={tzValue} onChange={(e) => setTzValue(e.target.value)}>
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
            <option value="__other__">Other (IANA id)…</option>
          </Select>
          {tzValue === "__other__" ? (
            <Input
              value={tzCustom}
              onChange={(e) => setTzCustom(e.target.value)}
              placeholder="Europe/Berlin"
              className="mt-2"
            />
          ) : null}
        </Field>
      </Section>

      <div className="flex items-center gap-2 border-t border-[var(--color-border-subtle)] pt-4">
        {status === "saved" ? (
          <Chip tone="success" className="mr-auto">
            Saved
          </Chip>
        ) : typeof status === "object" ? (
          <p className="mr-auto text-xs text-[var(--color-danger-300)]">{status.error}</p>
        ) : (
          <span className="mr-auto text-[11px] text-[var(--color-fg-700)]">
            Email + role are managed by an admin.
          </span>
        )}
        <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

function Avatar({ url, name }: { url: string; name: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt={`${name} avatar`}
        className={cn(
          "h-12 w-12 rounded-full object-cover",
          "ring-1 ring-inset ring-[var(--color-border-default)]",
        )}
      />
    );
  }
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!)
    .join("")
    .toUpperCase();
  return (
    <div
      aria-hidden
      className={cn(
        "grid h-12 w-12 place-items-center rounded-full",
        "bg-[var(--color-bg-900)] ring-1 ring-inset ring-[var(--color-border-default)]",
        "font-[family-name:var(--font-display)] text-sm font-semibold tracking-tight",
        "text-[var(--color-accent-300)]",
      )}
    >
      {initials || "·"}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-500)]">
        {title}
      </h3>
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
