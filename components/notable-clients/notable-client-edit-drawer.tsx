"use client";

import { Loader2, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
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
import { Textarea } from "@/components/ui/textarea";
import { upsertNotableClient } from "@/lib/notable-clients/actions";
import type { NotableClient } from "@/lib/notable-clients/queries";
import { cn } from "@/lib/utils";

const MARKET_OPTIONS = [
  { value: "CA", label: "🇨🇦 Canada" },
  { value: "MX", label: "🇲🇽 Mexico" },
  { value: "US", label: "🇺🇸 United States" },
  { value: "LATAM", label: "🌎 LATAM" },
];

interface Props {
  client: NotableClient | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FormState = {
  name: string;
  industry_tags_raw: string;    // comma-separated string for the input
  markets: string[];
  relationship_description: string;
  services_provided_raw: string; // comma-separated string
  key_result: string;
  description_en: string;
  description_es: string;
  is_active: boolean;
  sort_order: string;
};

const EMPTY: FormState = {
  name: "",
  industry_tags_raw: "",
  markets: [],
  relationship_description: "",
  services_provided_raw: "",
  key_result: "",
  description_en: "",
  description_es: "",
  is_active: true,
  sort_order: "0",
};

function toFormState(c: NotableClient): FormState {
  return {
    name: c.name,
    industry_tags_raw: c.industry_tags.join(", "),
    markets: c.markets,
    relationship_description: c.relationship_description ?? "",
    services_provided_raw: c.services_provided.join(", "),
    key_result: c.key_result ?? "",
    description_en: c.description_en ?? "",
    description_es: c.description_es ?? "",
    is_active: c.is_active,
    sort_order: String(c.sort_order),
  };
}

export function NotableClientEditDrawer({ client, open, onOpenChange }: Props) {
  const [state, setState] = React.useState<FormState>(EMPTY);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (client) {
      setState(toFormState(client));
    } else {
      setState(EMPTY);
    }
    setError(null);
  }, [client, open]);

  if (!open) return null;

  const field =
    <K extends keyof FormState>(key: K) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setState((s) => ({ ...s, [key]: e.target.value }));
    };

  const toggleMarket = (market: string) => {
    setState((s) => ({
      ...s,
      markets: s.markets.includes(market)
        ? s.markets.filter((m) => m !== market)
        : [...s.markets, market],
    }));
  };

  const handleSave = () => {
    setError(null);
    if (!state.name.trim()) {
      setError("Client name is required.");
      return;
    }
    startTransition(async () => {
      const result = await upsertNotableClient({
        id: client?.id,
        name: state.name,
        industry_tags: state.industry_tags_raw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        markets: state.markets,
        relationship_description: state.relationship_description || null,
        services_provided: state.services_provided_raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        key_result: state.key_result || null,
        description_en: state.description_en || null,
        description_es: state.description_es || null,
        is_active: state.is_active,
        sort_order: Number(state.sort_order) || 0,
      });

      if (result.ok) {
        onOpenChange(false);
      } else {
        setError(result.error);
      }
    });
  };

  const isNew = !client;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{isNew ? "New notable client" : client.name}</DrawerTitle>
          <DrawerDescription>
            {isNew
              ? "Add a marquee client for Tier 2 pitch hooks."
              : `${client.markets.join(", ")} · sort order ${client.sort_order}`}
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody>
          <div className="flex flex-col gap-6">
            {/* Identity */}
            <Section title="Identity">
              <Field label="Client name *">
                <Input value={state.name} onChange={field("name")} placeholder="Ford" />
              </Field>
              <Field
                label="Industry tags"
                hint="Comma-separated — used to match prospect industry for Tier 2 hooks."
              >
                <Input
                  value={state.industry_tags_raw}
                  onChange={field("industry_tags_raw")}
                  placeholder="automotive, manufacturing, transport"
                />
              </Field>
              <div>
                <Label className="mb-1.5 block text-xs">Markets</Label>
                <div className="flex flex-wrap gap-1.5">
                  {MARKET_OPTIONS.map(({ value, label }) => {
                    const selected = state.markets.includes(value);
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => toggleMarket(value)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1",
                          "text-xs font-medium ring-1 ring-inset transition-[background,color,box-shadow]",
                          selected
                            ? "bg-[color-mix(in_oklab,var(--color-accent-300),transparent_80%)] text-[var(--color-accent-300)] ring-[var(--color-accent-300)]"
                            : "bg-[var(--color-bg-900)] text-[var(--color-fg-300)] ring-[var(--color-border-default)] hover:text-[var(--color-fg-50)]",
                        )}
                        aria-pressed={selected}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </Section>

            {/* Relationship */}
            <Section
              title="Relationship"
              description="Used verbatim in Tier 2 pitch hooks — keep it punchy and specific."
            >
              <Field label="Relationship description">
                <Input
                  value={state.relationship_description}
                  onChange={field("relationship_description")}
                  placeholder="8+ years working together"
                />
              </Field>
              <Field label="Key result">
                <Input
                  value={state.key_result}
                  onChange={field("key_result")}
                  placeholder="400+ product packages designed"
                />
              </Field>
              <Field
                label="Services provided"
                hint="Comma-separated — for internal context only."
              >
                <Input
                  value={state.services_provided_raw}
                  onChange={field("services_provided_raw")}
                  placeholder="social media, production, packaging"
                />
              </Field>
            </Section>

            {/* Pitch narratives */}
            <Section
              title="Pitch narratives"
              description="Longer pitch-ready context Claude can draw from. Optional but improves Tier 2 quality."
            >
              <Field label="EN narrative">
                <Textarea
                  value={state.description_en}
                  onChange={field("description_en")}
                  rows={4}
                  placeholder="We scaled DiDi's social media operation from 1 team to 9 LATAM countries…"
                />
              </Field>
              <Field label="ES narrative">
                <Textarea
                  value={state.description_es}
                  onChange={field("description_es")}
                  rows={4}
                  placeholder="Escalamos la operación de redes sociales de DiDi de 1 equipo a 9 países…"
                />
              </Field>
            </Section>

            {/* Meta */}
            <Section title="Settings">
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <input
                    id="is-active"
                    type="checkbox"
                    checked={state.is_active}
                    onChange={(e) => setState((s) => ({ ...s, is_active: e.target.checked }))}
                    className="h-4 w-4 rounded border-[var(--color-border-default)] accent-[var(--color-accent-300)]"
                  />
                  <Label htmlFor="is-active" className="cursor-pointer">Active</Label>
                </div>
                <Field label="Sort order">
                  <Input
                    type="number"
                    value={state.sort_order}
                    onChange={field("sort_order")}
                    className="w-20"
                  />
                </Field>
              </div>
            </Section>
          </div>
        </DrawerBody>

        <DrawerFooter>
          {error ? (
            <p className="mr-auto text-xs text-[var(--color-danger-300)]">{error}</p>
          ) : null}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {saving ? "Saving…" : isNew ? "Create client" : "Save changes"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
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

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? (
        <p className="text-[11px] text-[var(--color-fg-700)]">{hint}</p>
      ) : null}
    </div>
  );
}
