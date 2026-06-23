"use client";

import {
  Archive,
  ArchiveRestore,
  FlaskConical,
  Loader2,
  MapPin,
  Plus,
  Sparkles,
  Users,
} from "lucide-react";
import * as React from "react";
import { Controller, useForm } from "react-hook-form";
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
import { TagInput, type TagSuggestionGroup } from "@/components/ui/tag-input";
import { Textarea } from "@/components/ui/textarea";
import { createIcp, softDeleteIcp, updateIcp } from "@/lib/icp/actions";
import {
  BUSINESS_TYPES,
  EXCLUDED_KEYWORDS,
  GEO_REGIONS,
  GOOGLE_PLACES_TYPES,
  INDUSTRY_TAGS,
  SEARCH_KEYWORDS,
} from "@/lib/icp/option-sources";
import type { Icp, IcpLanguage, IcpMarket } from "@/lib/icp/queries";
import type { IcpSuggestionLists } from "@/lib/icp/suggestions";
import { refineIcpFromEvidenceAction, suggestIcpFieldsAction } from "@/lib/icp/suggest-action";
import type { IcpProposed, IcpRefinement } from "@/lib/icp/refine-types";
import { GaryWizard } from "./gary-wizard";
import type { GaryProposedIcp } from "@/lib/icp/gary-types";
import { cn } from "@/lib/utils";

export type IcpDrawerMode =
  | { kind: "create" }
  | { kind: "edit"; icp: Icp };

interface IcpEditDrawerProps {
  mode: IcpDrawerMode | null;
  tenantSuggestions: IcpSuggestionLists;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** True when GOOGLE_PLACES_API_KEY is configured server-side. */
  placesKeyConfigured: boolean;
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

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v.trim());
  }
  return out;
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

/**
 * Build a two-group suggestion list for a TagInput field. Group 1 is
 * values already used elsewhere in this tenant (drives consistency);
 * group 2 is the canonical curated list (Google Places official set,
 * etc.). Values that appear in both are deduped — tenant wins so the
 * "Used by your team" label is accurate.
 */
function buildSuggestions(
  tenantValues: string[],
  canonical: readonly string[],
): TagSuggestionGroup[] {
  const tenantLower = new Set(tenantValues.map((v) => v.toLowerCase()));
  const canonicalFiltered = canonical.filter((v) => !tenantLower.has(v.toLowerCase()));
  const groups: TagSuggestionGroup[] = [];
  if (tenantValues.length > 0) {
    groups.push({ label: "Used by your team", values: tenantValues });
  }
  if (canonicalFiltered.length > 0) {
    groups.push({
      label: tenantValues.length > 0 ? "Standard" : null,
      values: canonicalFiltered,
    });
  }
  return groups;
}

export function IcpEditDrawer({
  mode,
  tenantSuggestions,
  open,
  onOpenChange,
  placesKeyConfigured,
}: IcpEditDrawerProps) {
  const {
    register,
    control,
    handleSubmit,
    reset,
    getValues,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormState>({ defaultValues: BLANK });

  const [serverError, setServerError] = React.useState<string | null>(null);
  const [saving, startSaving] = React.useTransition();
  const [archiving, startArchiving] = React.useTransition();
  const [suggesting, setSuggesting] = React.useState(false);
  const [suggestNote, setSuggestNote] = React.useState<string | null>(null);
  const [description, setDescription] = React.useState("");
  const [refining, setRefining] = React.useState(false);
  const [refinement, setRefinement] = React.useState<IcpRefinement | null>(null);
  const [garyApplied, setGaryApplied] = React.useState(false);

  // Reset the form whenever the mode changes (create vs. edit)
  React.useEffect(() => {
    if (mode?.kind === "edit") {
      reset(fromIcp(mode.icp));
    } else if (mode?.kind === "create") {
      reset(BLANK);
    }
    setServerError(null);
    setSuggestNote(null);
    setDescription("");
    setRefinement(null);
    setGaryApplied(false);
  }, [mode, reset]);

  if (!mode) return null;

  const isEdit = mode.kind === "edit";

  // Watch name for the "Suggest from name" button disabled state
  const nameValue = watch("name");

  const onSubmit = (data: FormState) => {
    setServerError(null);
    startSaving(async () => {
      const payload = {
        name: data.name.trim(),
        market: data.market,
        language: data.language,
        industry_tags: data.industry_tags,
        geo_regions: data.geo_regions,
        employee_size_min: parseNullableInt(data.employee_size_min),
        employee_size_max: parseNullableInt(data.employee_size_max),
        revenue_min_usd: parseNullableFloat(data.revenue_min_usd),
        revenue_max_usd: parseNullableFloat(data.revenue_max_usd),
        business_types: data.business_types,
        google_places_types: data.google_places_types,
        search_keywords: data.search_keywords,
        excluded_keywords: data.excluded_keywords,
        is_active: data.is_active,
      };

      const result = isEdit
        ? await updateIcp({ ...payload, id: mode.icp.id })
        : await createIcp(payload);

      if (result.ok) {
        onOpenChange(false);
      } else {
        setServerError(result.error);
      }
    });
  };

  const handleSuggest = async () => {
    setSuggestNote(null);
    setSuggesting(true);
    const current = getValues();
    try {
      const out = await suggestIcpFieldsAction({
        name: current.name,
        description: description.trim() || undefined,
        market: current.market,
        language: current.language,
        existing: {
          industry_tags: current.industry_tags,
          business_types: current.business_types,
          geo_regions: current.geo_regions,
          google_places_types: current.google_places_types,
          search_keywords: current.search_keywords,
          excluded_keywords: current.excluded_keywords,
        },
      });

      // If generating from a description and no name is set yet, adopt the
      // suggested name so the whole ICP comes from one plain-English prompt.
      if (out.name && !current.name.trim()) setValue("name", out.name);

      setValue("industry_tags", dedupe([...current.industry_tags, ...out.industry_tags]));
      setValue("business_types", dedupe([...current.business_types, ...out.business_types]));
      setValue("geo_regions", dedupe([...current.geo_regions, ...out.geo_regions]));
      setValue("google_places_types", dedupe([...current.google_places_types, ...out.google_places_types]));
      setValue("search_keywords", dedupe([...current.search_keywords, ...out.search_keywords]));
      setValue("excluded_keywords", dedupe([...current.excluded_keywords, ...out.excluded_keywords]));
      // Only overwrite size/revenue fields if they're currently blank
      if (!current.employee_size_min) setValue("employee_size_min", out.employee_size_min ?? "");
      if (!current.employee_size_max) setValue("employee_size_max", out.employee_size_max ?? "");
      if (!current.revenue_min_usd) setValue("revenue_min_usd", out.revenue_min_usd ?? "");
      if (!current.revenue_max_usd) setValue("revenue_max_usd", out.revenue_max_usd ?? "");

      setSuggestNote(out.reasoning);
    } catch {
      setSuggestNote("AI suggestion failed — please try again.");
    } finally {
      setSuggesting(false);
    }
  };

  /** Populate the whole form from a Gary proposal (review-only; never auto-saves). */
  const applyGaryProposal = (icp: GaryProposedIcp) => {
    setValue("name", icp.name);
    setValue("market", icp.market);
    setValue("language", icp.language);
    setValue("industry_tags", dedupe(icp.industry_tags));
    setValue("business_types", dedupe(icp.business_types));
    setValue("geo_regions", dedupe(icp.geo_regions));
    setValue("google_places_types", dedupe(icp.google_places_types));
    setValue("search_keywords", dedupe(icp.search_keywords));
    setValue("excluded_keywords", dedupe(icp.excluded_keywords));
    setValue("employee_size_min", icp.employee_size_min ?? "");
    setValue("employee_size_max", icp.employee_size_max ?? "");
    setValue("revenue_min_usd", icp.revenue_min_usd ?? "");
    setValue("revenue_max_usd", icp.revenue_max_usd ?? "");
    setGaryApplied(true);
  };

  const handleRefine = async () => {
    if (mode?.kind !== "edit") return;
    setRefining(true);
    setRefinement(null);
    try {
      const out = await refineIcpFromEvidenceAction(mode.icp.id);
      setRefinement(out);
    } catch {
      setRefinement({
        ok: false,
        evidence: {
          prospectCount: 0,
          researchedCount: 0,
          avgScore: null,
          topPains: [],
          topTech: [],
          industriesPresent: [],
          whatTheyDoSamples: [],
          scoreReasoningSamples: [],
          runnaStrength: { caseStudyIndustries: [], coveredPains: [], services: [] },
        },
        proposed: {
          industry_tags: [],
          business_types: [],
          search_keywords: [],
          excluded_keywords: [],
          employee_size_min: null,
          employee_size_max: null,
        },
        fieldRationales: {},
        summary: "Refinement failed — please try again.",
        method: "insufficient_data",
        note: "",
      });
    } finally {
      setRefining(false);
    }
  };

  /** Merge a proposed array field into current form values (additive, deduped). */
  const applyArrayField = (
    field: "industry_tags" | "business_types" | "search_keywords" | "excluded_keywords",
    values: string[],
  ) => {
    setValue(field, dedupe([...getValues(field), ...values]));
    setRefinement((prev) =>
      prev ? { ...prev, proposed: { ...prev.proposed, [field]: [] } } : prev,
    );
  };

  const applySizeField = (
    field: "employee_size_min" | "employee_size_max",
    value: string | null,
  ) => {
    if (value) setValue(field, value);
    setRefinement((prev) =>
      prev ? { ...prev, proposed: { ...prev.proposed, [field]: null } } : prev,
    );
  };

  const handleArchive = () => {
    if (!isEdit) return;
    setServerError(null);
    startArchiving(async () => {
      const result = await softDeleteIcp(mode.icp.id);
      if (result.ok) {
        onOpenChange(false);
      } else {
        setServerError(result.error);
      }
    });
  };

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
          <div className="mt-3 flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-bg-800)] p-3">
            <Label htmlFor="icp-describe" className="flex items-center gap-1.5 text-xs">
              <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent-300)]" aria-hidden />
              Describe your ideal customer
            </Label>
            <Textarea
              id="icp-describe"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. boutique fitness studios in Calgary &amp; Edmonton, 5–30 staff, that sell branded apparel online"
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={handleSuggest}
                disabled={suggesting || (!nameValue.trim() && !description.trim())}
                title={
                  description.trim()
                    ? "Generate the whole ICP — name, industries, geo, keywords — from your description"
                    : nameValue.trim()
                      ? "Auto-fill all fields from the ICP name"
                      : "Describe your customer (or type a name) first"
                }
              >
                {suggesting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" aria-hidden />
                )}
                {description.trim() ? "Generate ICP" : "Suggest from name"}
              </Button>
              <span className="text-[10px] text-[var(--color-fg-700)]">
                Powered by Claude · fills every field
              </span>
            </div>
          </div>
          {!isEdit ? (
            <GaryWizard onApply={applyGaryProposal} applied={garyApplied} />
          ) : null}

          {suggestNote ? (
            <p className="mt-1 text-[11px] italic text-[var(--color-fg-500)]">
              {suggestNote}
            </p>
          ) : null}

          {isEdit ? (
            <div className="mt-2 flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-bg-800)] p-3">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={handleRefine}
                  disabled={refining}
                  title="Analyze the prospects already assigned to this ICP (research + fit scores) and suggest sharper targeting, cross-referenced with Runna's strongest case studies"
                >
                  {refining ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <FlaskConical className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {refining ? "Analyzing evidence…" : "Refine from evidence"}
                </Button>
                <span className="text-[10px] text-[var(--color-fg-700)]">
                  Learns from assigned prospects · suggest-only
                </span>
              </div>
              {refinement ? (
                <RefinePanel
                  refinement={refinement}
                  onApplyArray={applyArrayField}
                  onApplySize={applySizeField}
                />
              ) : null}
            </div>
          ) : null}
        </DrawerHeader>

        <DrawerBody>
          <form id="icp-form" onSubmit={handleSubmit(onSubmit)}>
            <div className="flex flex-col gap-6">
              <Section title="Identity">
                <Field label="Name" error={errors.name?.message}>
                  <Input
                    {...register("name", { required: "Name is required" })}
                    placeholder="Alberta DTC ecommerce, 5-50 employees"
                    aria-invalid={!!errors.name}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Market">
                    <Controller
                      control={control}
                      name="market"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onChange={(e) => field.onChange(e.target.value as IcpMarket)}
                        >
                          <option value="CA">🇨🇦 Canada</option>
                          <option value="MX">🇲🇽 Mexico</option>
                          <option value="US">🇺🇸 United States</option>
                          <option value="LATAM">🌎 LATAM</option>
                        </Select>
                      )}
                    />
                  </Field>
                  <Field label="Language">
                    <Controller
                      control={control}
                      name="language"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onChange={(e) => field.onChange(e.target.value as IcpLanguage)}
                        >
                          <option value="en">English</option>
                          <option value="es">Español</option>
                        </Select>
                      )}
                    />
                  </Field>
                </div>
                <Field label="Status">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-[var(--color-fg-300)]">
                    <Controller
                      control={control}
                      name="is_active"
                      render={({ field }) => (
                        <input
                          type="checkbox"
                          checked={field.value}
                          onChange={(e) => field.onChange(e.target.checked)}
                          className="h-4 w-4 accent-[var(--color-accent-300)]"
                        />
                      )}
                    />
                    Active — visible to Discovery &amp; pitch generator
                  </label>
                </Field>
              </Section>

              <Section
                title="Targeting"
                description="Industries and business types the ICP should match. Empty = no filter."
              >
                <Field label="Industry tags">
                  <Controller
                    control={control}
                    name="industry_tags"
                    render={({ field }) => (
                      <TagInput
                        value={field.value}
                        onChange={field.onChange}
                        placeholder="dtc, ecommerce, consumer goods…"
                        suggestions={buildSuggestions(tenantSuggestions.industry_tags, INDUSTRY_TAGS)}
                      />
                    )}
                  />
                </Field>
                <Field label="Business types">
                  <Controller
                    control={control}
                    name="business_types"
                    render={({ field }) => (
                      <TagInput
                        value={field.value}
                        onChange={field.onChange}
                        placeholder="dtc_ecommerce, professional_services…"
                        suggestions={buildSuggestions(tenantSuggestions.business_types, BUSINESS_TYPES)}
                      />
                    )}
                  />
                </Field>
              </Section>

              <Section
                title="Geography"
                description="Regions the ICP operates in. City or province names work — Discovery resolves these via Places when creds land."
              >
                <Field label="Regions">
                  <Controller
                    control={control}
                    name="geo_regions"
                    render={({ field }) => (
                      <TagInput
                        value={field.value}
                        onChange={field.onChange}
                        placeholder="Alberta, Calgary, Edmonton…"
                        suggestions={buildSuggestions(tenantSuggestions.geo_regions, GEO_REGIONS)}
                      />
                    )}
                  />
                </Field>
                <Field label="Google Places types">
                  <Controller
                    control={control}
                    name="google_places_types"
                    render={({ field }) => (
                      <TagInput
                        value={field.value}
                        onChange={field.onChange}
                        placeholder="store, lawyer, accounting…"
                        suggestions={buildSuggestions(
                          tenantSuggestions.google_places_types,
                          GOOGLE_PLACES_TYPES,
                        )}
                      />
                    )}
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
                  minProps={register("employee_size_min", {
                    validate: (v) => {
                      if (!v) return true;
                      const max = getValues("employee_size_max");
                      if (!max) return true;
                      return parseNullableInt(v)! <= parseNullableInt(max)!
                        ? true
                        : "Min must be ≤ max";
                    },
                  })}
                  maxProps={register("employee_size_max", {
                    validate: (v) => {
                      if (!v) return true;
                      const min = getValues("employee_size_min");
                      if (!min) return true;
                      return parseNullableInt(min)! <= parseNullableInt(v)!
                        ? true
                        : "Max must be ≥ min";
                    },
                  })}
                  minError={errors.employee_size_min?.message}
                  maxError={errors.employee_size_max?.message}
                  placeholder={["5", "50"]}
                />
                <RangeField
                  label="Revenue (USD)"
                  minProps={register("revenue_min_usd", {
                    validate: (v) => {
                      if (!v) return true;
                      const max = getValues("revenue_max_usd");
                      if (!max) return true;
                      return parseNullableFloat(v)! <= parseNullableFloat(max)!
                        ? true
                        : "Min must be ≤ max";
                    },
                  })}
                  maxProps={register("revenue_max_usd", {
                    validate: (v) => {
                      if (!v) return true;
                      const min = getValues("revenue_min_usd");
                      if (!min) return true;
                      return parseNullableFloat(min)! <= parseNullableFloat(v)!
                        ? true
                        : "Max must be ≥ min";
                    },
                  })}
                  minError={errors.revenue_min_usd?.message}
                  maxError={errors.revenue_max_usd?.message}
                  placeholder={["500000", "5000000"]}
                />
              </Section>

              <Section
                title="Keywords"
                description="Search keywords drive the Discovery query; excluded keywords hard-filter the result set."
              >
                <Field label="Search keywords">
                  <Controller
                    control={control}
                    name="search_keywords"
                    render={({ field }) => (
                      <TagInput
                        value={field.value}
                        onChange={field.onChange}
                        placeholder="shopify, dtc brand, online shop…"
                        suggestions={buildSuggestions(
                          tenantSuggestions.search_keywords,
                          SEARCH_KEYWORDS,
                        )}
                      />
                    )}
                  />
                </Field>
                <Field label="Excluded keywords">
                  <Controller
                    control={control}
                    name="excluded_keywords"
                    render={({ field }) => (
                      <TagInput
                        value={field.value}
                        onChange={field.onChange}
                        placeholder="dropshipping, MLM, cannabis retail…"
                        suggestions={buildSuggestions(
                          tenantSuggestions.excluded_keywords,
                          EXCLUDED_KEYWORDS,
                        )}
                      />
                    )}
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
          </form>
        </DrawerBody>

        <DrawerFooter>
          {serverError ? (
            <p className="mr-auto max-w-xs truncate text-xs text-[var(--color-danger-300)]">
              {serverError}
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
          <Button type="submit" form="icp-form" variant="primary" disabled={saving || archiving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create ICP"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

const ARRAY_FIELD_LABELS: Record<keyof IcpProposed, string> = {
  industry_tags: "Industry tags",
  business_types: "Business types",
  search_keywords: "Search keywords",
  excluded_keywords: "Excluded keywords",
  employee_size_min: "Employee size (min)",
  employee_size_max: "Employee size (max)",
};

function RefinePanel({
  refinement,
  onApplyArray,
  onApplySize,
}: {
  refinement: IcpRefinement;
  onApplyArray: (
    field: "industry_tags" | "business_types" | "search_keywords" | "excluded_keywords",
    values: string[],
  ) => void;
  onApplySize: (field: "employee_size_min" | "employee_size_max", value: string | null) => void;
}) {
  const { evidence, proposed, fieldRationales } = refinement;
  const arrayFields = (
    ["industry_tags", "business_types", "search_keywords", "excluded_keywords"] as const
  ).filter((f) => proposed[f].length > 0);
  const sizeFields = (["employee_size_min", "employee_size_max"] as const).filter(
    (f) => proposed[f],
  );
  const hasProposals = arrayFields.length > 0 || sizeFields.length > 0;

  return (
    <div className="flex flex-col gap-2 text-[11px]">
      {/* Evidence snapshot */}
      {evidence.prospectCount > 0 ? (
        <p className="text-[var(--color-fg-500)]">
          Based on{" "}
          <span className="font-medium text-[var(--color-fg-300)]">
            {evidence.researchedCount}/{evidence.prospectCount}
          </span>{" "}
          researched prospects
          {evidence.avgScore !== null ? ` · avg fit ${evidence.avgScore}` : ""}.
        </p>
      ) : null}

      <p className="text-[var(--color-fg-300)]">{refinement.summary}</p>

      {evidence.topPains.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[var(--color-fg-700)]">Common pains:</span>
          {evidence.topPains.slice(0, 5).map((p) => (
            <Chip key={p.name} tone="neutral" className="text-[10px]">
              {p.name} · {p.count}
            </Chip>
          ))}
        </div>
      ) : null}

      {/* Proposed field changes — apply each individually */}
      {hasProposals ? (
        <div className="mt-1 flex flex-col gap-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-900)] p-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg-700)]">
            Suggested additions
          </span>
          {arrayFields.map((field) => (
            <div key={field} className="flex flex-col gap-1">
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <span className="font-medium text-[var(--color-fg-300)]">
                    {ARRAY_FIELD_LABELS[field]}
                  </span>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {proposed[field].map((v) => (
                      <Chip key={v} tone="accent" className="text-[10px]">
                        {v}
                      </Chip>
                    ))}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => onApplyArray(field, proposed[field])}
                >
                  <Plus className="h-3 w-3" aria-hidden /> Add
                </Button>
              </div>
              {fieldRationales[field] ? (
                <p className="italic text-[var(--color-fg-700)]">{fieldRationales[field]}</p>
              ) : null}
            </div>
          ))}
          {sizeFields.map((field) => (
            <div key={field} className="flex items-center gap-2">
              <span className="flex-1">
                <span className="font-medium text-[var(--color-fg-300)]">
                  {ARRAY_FIELD_LABELS[field]}:
                </span>{" "}
                {proposed[field]}
                {fieldRationales[field] ? (
                  <span className="italic text-[var(--color-fg-700)]"> — {fieldRationales[field]}</span>
                ) : null}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="shrink-0"
                onClick={() => onApplySize(field, proposed[field])}
              >
                <Plus className="h-3 w-3" aria-hidden /> Set
              </Button>
            </div>
          ))}
        </div>
      ) : refinement.ok ? (
        <p className="italic text-[var(--color-fg-700)]">
          No new field suggestions — the current targeting already matches the evidence.
        </p>
      ) : null}

      {refinement.note ? (
        <p className="mt-1 flex items-start gap-1 text-[10px] text-[var(--color-warning-300)]">
          <span aria-hidden>⚠</span>
          <span>{refinement.note}</span>
        </p>
      ) : null}
    </div>
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
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {error ? (
        <p className="text-[11px] text-[var(--color-danger-300)]">{error}</p>
      ) : null}
    </div>
  );
}

function RangeField({
  label,
  icon,
  minProps,
  maxProps,
  minError,
  maxError,
  placeholder,
}: {
  label: string;
  icon?: React.ReactNode;
  minProps: React.InputHTMLAttributes<HTMLInputElement> & { name: string; ref: React.Ref<HTMLInputElement> };
  maxProps: React.InputHTMLAttributes<HTMLInputElement> & { name: string; ref: React.Ref<HTMLInputElement> };
  minError?: string;
  maxError?: string;
  placeholder: [string, string];
}) {
  return (
    <Field label={label} error={minError ?? maxError}>
      <div className="flex items-center gap-2">
        {icon ? <span className="text-[var(--color-fg-700)]">{icon}</span> : null}
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          placeholder={placeholder[0]}
          aria-invalid={!!minError}
          {...minProps}
        />
        <span className={cn("text-xs text-[var(--color-fg-700)]")}>to</span>
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          placeholder={placeholder[1]}
          aria-invalid={!!maxError}
          {...maxProps}
        />
      </div>
    </Field>
  );
}
