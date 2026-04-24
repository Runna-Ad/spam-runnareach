"use client";

import { Archive, ArchiveRestore, Loader2, MapPin, Users } from "lucide-react";
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
import { Select } from "@/components/ui/select";
import { TagInput } from "@/components/ui/tag-input";
import { createIcp, softDeleteIcp, updateIcp } from "@/lib/icp/actions";
import type { Icp, IcpLanguage, IcpMarket } from "@/lib/icp/queries";
import { cn } from "@/lib/utils";

export type IcpDrawerMode =
  | { kind: "create" }
  | { kind: "edit"; icp: Icp };

interface IcpEditDrawerProps {
  mode: IcpDrawerMode | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FormState = {
  name: string;
  market: IcpMarket;
  language: IcpLanguage;
  industry_tags: string[];
  geo_regions: string[];
  employee_size_min: string;
  employee_size_max: string;
  revenue_min_usd: string;
  revenue_max_usd: string;
  business_types: string[];
  google_places_types: string[];
  search_keywords: string[];
  excluded_keywords: string[];
  is_active: boolean;
};

const BLANK: FormState = {
  name: "",
  market: "CA",
  language: "en",
  industry_tags: [],
  geo_regions: [],
  employee_size_min: "",
  employee_size_max: "",
  revenue_min_usd: "",
  revenue_max_usd: "",
  business_types: [],
  google_places_types: [],
  search_keywords: [],
  excluded_keywords: [],
  is_active: true,
};

function fromIcp(icp: Icp): FormState {
  return {
    name: icp.name,
    market: icp.market,
    language: icp.language,
    industry_tags: icp.industry_tags,
    geo_regions: icp.geo_regions,
    employee_size_min: icp.employee_size_min?.toString() ?? "",
    employee_size_max: icp.employee_size_max?.toString() ?? "",
    revenue_min_usd: icp.revenue_min_usd?.toString() ?? "",
    revenue_max_usd: icp.revenue_max_usd?.toString() ?? "",
    business_types: icp.business_types,
    google_places_types: icp.google_places_types,
    search_keywords: icp.search_keywords,
    excluded_keywords: icp.excluded_keywords,
    is_active: icp.is_active,
  };
}

function parseNullableInt(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === "") return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseNullableFloat(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === "") return null;
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function IcpEditDrawer({ mode, open, onOpenChange }: IcpEditDrawerProps) {
  const [state, setState] = React.useState<FormState>(BLANK);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, startSaving] = React.useTransition();
  const [archiving, startArchiving] = React.useTransition();

  React.useEffect(() => {
    if (mode?.kind === "edit") {
      setState(fromIcp(mode.icp));
    } else if (mode?.kind === "create") {
      setState(BLANK);
    }
    setError(null);
  }, [mode]);

  if (!mode) return null;

  const isEdit = mode.kind === "edit";
  const updateField = <K extends keyof FormState>(k: K) => (v: FormState[K]) =>
    setState((s) => ({ ...s, [k]: v }));

  const handleSave = () => {
    setError(null);
    startSaving(async () => {
      const payload = {
        name: state.name.trim(),
        market: state.market,
        language: state.language,
        industry_tags: state.industry_tags,
        geo_regions: state.geo_regions,
        employee_size_min: parseNullableInt(state.employee_size_min),
        employee_size_max: parseNullableInt(state.employee_size_max),
        revenue_min_usd: parseNullableFloat(state.revenue_min_usd),
        revenue_max_usd: parseNullableFloat(state.revenue_max_usd),
        business_types: state.business_types,
        google_places_types: state.google_places_types,
        search_keywords: state.search_keywords,
        excluded_keywords: state.excluded_keywords,
        is_active: state.is_active,
      };

      const result = isEdit
        ? await updateIcp({ ...payload, id: mode.icp.id })
        : await createIcp(payload);

      if (result.ok) {
        onOpenChange(false);
      } else {
        setError(result.error);
      }
    });
  };

  const handleArchive = () => {
    if (!isEdit) return;
    setError(null);
    startArchiving(async () => {
      const result = await softDeleteIcp(mode.icp.id);
      if (result.ok) {
        onOpenChange(false);
      } else {
        setError(result.error);
      }
    });
  };

  const placesKeyConfigured = false; // TODO: flip when Google Places API key lands
  const preview = isEdit ? mode.icp.reachable_pool_count : null;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{isEdit ? mode.icp.name : "New ICP"}</DrawerTitle>
          <DrawerDescription>
            {isEdit
              ? `Edit targeting for this ICP. Used by Discovery to size the reachable pool and by the pitch generator to match case studies.`
              : "Define targeting for a new ideal customer profile. All fields except name are optional; empty arrays mean no constraint on that dimension."}
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody>
          <div className="flex flex-col gap-6">
            <Section title="Identity">
              <Field label="Name">
                <Input
                  value={state.name}
                  onChange={(e) => updateField("name")(e.target.value)}
                  placeholder="Alberta DTC ecommerce, 5-50 employees"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Market">
                  <Select
                    value={state.market}
                    onChange={(e) => updateField("market")(e.target.value as IcpMarket)}
                  >
                    <option value="CA">🇨🇦 Canada</option>
                    <option value="MX">🇲🇽 Mexico</option>
                    <option value="US">🇺🇸 United States</option>
                    <option value="LATAM">🌎 LATAM</option>
                  </Select>
                </Field>
                <Field label="Language">
                  <Select
                    value={state.language}
                    onChange={(e) => updateField("language")(e.target.value as IcpLanguage)}
                  >
                    <option value="en">English</option>
                    <option value="es">Español</option>
                  </Select>
                </Field>
              </div>
              <Field label="Status">
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-[var(--color-fg-300)]">
                  <input
                    type="checkbox"
                    checked={state.is_active}
                    onChange={(e) => updateField("is_active")(e.target.checked)}
                    className="h-4 w-4 accent-[var(--color-accent-300)]"
                  />
                  Active — visible to Discovery & pitch generator
                </label>
              </Field>
            </Section>

            <Section
              title="Targeting"
              description="Industries and business types the ICP should match. Empty = no filter."
            >
              <Field label="Industry tags">
                <TagInput
                  value={state.industry_tags}
                  onChange={updateField("industry_tags")}
                  placeholder="dtc, ecommerce, consumer goods…"
                />
              </Field>
              <Field label="Business types">
                <TagInput
                  value={state.business_types}
                  onChange={updateField("business_types")}
                  placeholder="dtc_ecommerce, professional_services…"
                />
              </Field>
            </Section>

            <Section
              title="Geography"
              description="Regions the ICP operates in. City or province names work — Discovery resolves these via Places when creds land."
            >
              <Field label="Regions">
                <TagInput
                  value={state.geo_regions}
                  onChange={updateField("geo_regions")}
                  placeholder="Alberta, Calgary, Edmonton…"
                />
              </Field>
              <Field label="Google Places types">
                <TagInput
                  value={state.google_places_types}
                  onChange={updateField("google_places_types")}
                  placeholder="store, lawyer, accounting…"
                />
              </Field>
            </Section>

            <Section
              title="Size & revenue"
              description="Employee + revenue ranges are both optional. Leave blank for no constraint."
            >
              <RangeField
                icon={<Users className="h-3 w-3" aria-hidden />}
                label="Employees"
                minValue={state.employee_size_min}
                maxValue={state.employee_size_max}
                onMinChange={updateField("employee_size_min")}
                onMaxChange={updateField("employee_size_max")}
                placeholder={["5", "50"]}
              />
              <RangeField
                label="Revenue (USD)"
                minValue={state.revenue_min_usd}
                maxValue={state.revenue_max_usd}
                onMinChange={updateField("revenue_min_usd")}
                onMaxChange={updateField("revenue_max_usd")}
                placeholder={["500000", "5000000"]}
              />
            </Section>

            <Section
              title="Keywords"
              description="Search keywords drive the Discovery query; excluded keywords hard-filter the result set."
            >
              <Field label="Search keywords">
                <TagInput
                  value={state.search_keywords}
                  onChange={updateField("search_keywords")}
                  placeholder="shopify, dtc brand, online shop…"
                />
              </Field>
              <Field label="Excluded keywords">
                <TagInput
                  value={state.excluded_keywords}
                  onChange={updateField("excluded_keywords")}
                  placeholder="dropshipping, MLM, cannabis retail…"
                />
              </Field>
            </Section>

            <Section
              title="Places reachable-pool preview"
              description="Sizes the pool of real businesses that match this ICP via Google Places. Requires the Places API key."
            >
              <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-default)] bg-[var(--color-bg-900)] p-3">
                <MapPin className="h-4 w-4 text-[var(--color-fg-500)]" aria-hidden />
                <div className="flex flex-1 flex-col">
                  <span className="text-xs text-[var(--color-fg-500)]">
                    {placesKeyConfigured
                      ? preview !== null
                        ? `Last preview: ${preview.toLocaleString()} reachable`
                        : "Not computed yet"
                      : "Google Places API key required — add it to .env.local to enable preview."}
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!placesKeyConfigured || !isEdit}
                  onClick={() => {
                    /* wired when Places key lands */
                  }}
                >
                  Preview pool
                </Button>
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
          {isEdit && mode.icp.is_active ? (
            <Button
              type="button"
              variant="ghost"
              onClick={handleArchive}
              disabled={archiving || saving}
              className="mr-auto"
            >
              {archiving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Archive className="h-3.5 w-3.5" aria-hidden />
              )}
              Archive
            </Button>
          ) : null}
          {isEdit && !mode.icp.is_active ? (
            <Chip tone="warning" className="mr-auto gap-1">
              <ArchiveRestore className="h-3 w-3" aria-hidden />
              Archived — toggle "Active" above + Save to restore
            </Chip>
          ) : null}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={handleSave} disabled={saving || archiving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create ICP"}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function RangeField({
  label,
  icon,
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
  placeholder,
}: {
  label: string;
  icon?: React.ReactNode;
  minValue: string;
  maxValue: string;
  onMinChange: (v: string) => void;
  onMaxChange: (v: string) => void;
  placeholder: [string, string];
}) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        {icon ? <span className="text-[var(--color-fg-700)]">{icon}</span> : null}
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          value={minValue}
          onChange={(e) => onMinChange(e.target.value)}
          placeholder={placeholder[0]}
        />
        <span className={cn("text-xs text-[var(--color-fg-700)]")}>to</span>
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          value={maxValue}
          onChange={(e) => onMaxChange(e.target.value)}
          placeholder={placeholder[1]}
        />
      </div>
    </Field>
  );
}
