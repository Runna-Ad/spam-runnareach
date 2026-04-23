"use client";

import { Languages, Loader2, Plus, Trash2 } from "lucide-react";
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
import { updateCaseStudy } from "@/lib/case-studies/actions";
import type {
  CaseStudyWithRelations,
  MeasurableResult,
  PainTaxonomy,
  ServiceLite,
} from "@/lib/case-studies/queries";
import { cn } from "@/lib/utils";

interface CaseStudyEditDrawerProps {
  caseStudy: CaseStudyWithRelations | null;
  painTaxonomy: PainTaxonomy[];
  services: ServiceLite[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FormState = {
  client_name: string;
  industry: string;
  logo_url: string;
  hero_metric_en: string;
  hero_metric_es: string;
  result_description_en: string;
  result_description_es: string;
  testimonial_quote_en: string;
  testimonial_quote_es: string;
  testimonial_author: string;
  testimonial_title: string;
  measurable_results: MeasurableResult[];
  pain_tag_ids: string[];
};

const EMPTY_STATE: FormState = {
  client_name: "",
  industry: "",
  logo_url: "",
  hero_metric_en: "",
  hero_metric_es: "",
  result_description_en: "",
  result_description_es: "",
  testimonial_quote_en: "",
  testimonial_quote_es: "",
  testimonial_author: "",
  testimonial_title: "",
  measurable_results: [],
  pain_tag_ids: [],
};

function toFormState(cs: CaseStudyWithRelations): FormState {
  return {
    client_name: cs.client_name,
    industry: cs.industry ?? "",
    logo_url: cs.logo_url ?? "",
    hero_metric_en: cs.hero_metric_en ?? "",
    hero_metric_es: cs.hero_metric_es ?? "",
    result_description_en: cs.result_description_en ?? "",
    result_description_es: cs.result_description_es ?? "",
    testimonial_quote_en: cs.testimonial_quote_en ?? "",
    testimonial_quote_es: cs.testimonial_quote_es ?? "",
    testimonial_author: cs.testimonial_author ?? "",
    testimonial_title: cs.testimonial_title ?? "",
    measurable_results: cs.measurable_results,
    pain_tag_ids: cs.pain_tags.map((p) => p.pain_id),
  };
}

export function CaseStudyEditDrawer({
  caseStudy,
  painTaxonomy,
  services,
  open,
  onOpenChange,
}: CaseStudyEditDrawerProps) {
  const [state, setState] = React.useState<FormState>(EMPTY_STATE);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (caseStudy) {
      setState(toFormState(caseStudy));
      setError(null);
    }
  }, [caseStudy]);

  if (!caseStudy) return null;

  const handleField =
    <K extends keyof FormState>(key: K) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setState((s) => ({ ...s, [key]: e.target.value }));
    };

  const togglePainTag = (id: string) => {
    setState((s) => ({
      ...s,
      pain_tag_ids: s.pain_tag_ids.includes(id)
        ? s.pain_tag_ids.filter((x) => x !== id)
        : [...s.pain_tag_ids, id],
    }));
  };

  const addMeasurableResult = () => {
    setState((s) => ({
      ...s,
      measurable_results: [...s.measurable_results, { metric: "", label: "" }],
    }));
  };

  const updateMeasurableResult = (i: number, field: "metric" | "label", v: string) => {
    setState((s) => ({
      ...s,
      measurable_results: s.measurable_results.map((r, idx) =>
        idx === i ? { ...r, [field]: v } : r,
      ),
    }));
  };

  const removeMeasurableResult = (i: number) => {
    setState((s) => ({
      ...s,
      measurable_results: s.measurable_results.filter((_, idx) => idx !== i),
    }));
  };

  const handleSave = () => {
    setError(null);
    startTransition(async () => {
      const cleanedResults = state.measurable_results
        .map((r) => ({ metric: r.metric.trim(), label: r.label.trim() }))
        .filter((r) => r.metric.length > 0 && r.label.length > 0);

      const result = await updateCaseStudy({
        id: caseStudy.id,
        client_name: state.client_name,
        industry: state.industry || null,
        logo_url: state.logo_url || null,
        hero_metric_en: state.hero_metric_en || null,
        hero_metric_es: state.hero_metric_es || null,
        result_description_en: state.result_description_en || null,
        result_description_es: state.result_description_es || null,
        testimonial_quote_en: state.testimonial_quote_en || null,
        testimonial_quote_es: state.testimonial_quote_es || null,
        testimonial_author: state.testimonial_author || null,
        testimonial_title: state.testimonial_title || null,
        measurable_results: cleanedResults,
        pain_tag_ids: state.pain_tag_ids,
      });

      if (result.ok) {
        onOpenChange(false);
      } else {
        setError(result.error);
      }
    });
  };

  const featuredServices = services.filter((s) =>
    caseStudy.featured_services_id.includes(s.id),
  );

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{caseStudy.client_name}</DrawerTitle>
          <DrawerDescription>
            {caseStudy.industry ?? "Case study"} · sort order {caseStudy.sort_order}
          </DrawerDescription>
          {featuredServices.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {featuredServices.map((s) => (
                <Chip key={s.id} tone="accent">
                  {s.display_name_en}
                </Chip>
              ))}
            </div>
          ) : null}
        </DrawerHeader>

        <DrawerBody>
          <div className="flex flex-col gap-6">
            <Section title="Identity">
              <Field label="Client name">
                <Input value={state.client_name} onChange={handleField("client_name")} />
              </Field>
              <Field label="Industry">
                <Input
                  value={state.industry}
                  onChange={handleField("industry")}
                  placeholder="Automotive / enterprise training"
                />
              </Field>
              <Field label="Logo URL">
                <Input
                  value={state.logo_url}
                  onChange={handleField("logo_url")}
                  placeholder="https://…/logo.svg"
                />
              </Field>
            </Section>

            <BilingualSection
              title="Hero metric"
              enLabel="Hero metric (EN)"
              esLabel="Hero metric (ES)"
              enValue={state.hero_metric_en}
              esValue={state.hero_metric_es}
              onEnChange={handleField("hero_metric_en")}
              onEsChange={handleField("hero_metric_es")}
              placeholder="35K downloads, 1M impressions"
            />

            <BilingualSection
              title="Result description"
              enLabel="Result description (EN)"
              esLabel="Result description (ES)"
              enValue={state.result_description_en}
              esValue={state.result_description_es}
              onEnChange={handleField("result_description_en")}
              onEsChange={handleField("result_description_es")}
              placeholder="Full paragraph describing the scope and outcome."
              multiline
            />

            <Section title="Testimonial (optional)">
              <Field label="Quote (EN)">
                <Textarea
                  value={state.testimonial_quote_en}
                  onChange={handleField("testimonial_quote_en")}
                  rows={4}
                />
              </Field>
              <Field label="Quote (ES)">
                <Textarea
                  value={state.testimonial_quote_es}
                  onChange={handleField("testimonial_quote_es")}
                  rows={4}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Author">
                  <Input
                    value={state.testimonial_author}
                    onChange={handleField("testimonial_author")}
                    placeholder="Ana C Díaz Montes"
                  />
                </Field>
                <Field label="Title">
                  <Input
                    value={state.testimonial_title}
                    onChange={handleField("testimonial_title")}
                    placeholder="Head of Experiential"
                  />
                </Field>
              </div>
            </Section>

            <Section
              title="Measurable results"
              description="Each row appears as a metric-label pair wherever the case is referenced."
            >
              {state.measurable_results.length === 0 ? (
                <p className="text-xs italic text-[var(--color-fg-700)]">No measurable results.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {state.measurable_results.map((r, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <Input
                        value={r.metric}
                        onChange={(e) => updateMeasurableResult(i, "metric", e.target.value)}
                        placeholder="+1,400%"
                        className="max-w-[40%]"
                      />
                      <Input
                        value={r.label}
                        onChange={(e) => updateMeasurableResult(i, "label", e.target.value)}
                        placeholder="positive sentiment"
                      />
                      <button
                        type="button"
                        onClick={() => removeMeasurableResult(i)}
                        className={cn(
                          "grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-md)]",
                          "text-[var(--color-fg-500)]",
                          "hover:bg-[var(--color-bg-700)] hover:text-[var(--color-danger-300)]",
                          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-300)]",
                        )}
                        aria-label="Remove result"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <Button type="button" size="sm" variant="secondary" onClick={addMeasurableResult}>
                <Plus className="h-3.5 w-3.5" aria-hidden /> Add result
              </Button>
            </Section>

            <Section
              title="Pain tags"
              description="Which pains does this case demonstrably address? Used by the pitch generator to match prospects."
            >
              <div className="flex flex-wrap gap-1.5">
                {painTaxonomy.map((p) => {
                  const selected = state.pain_tag_ids.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => togglePainTag(p.id)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1",
                        "text-xs font-medium tracking-tight",
                        "ring-1 ring-inset transition-[background,color,box-shadow]",
                        "duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-300)]",
                        selected
                          ? "bg-[color-mix(in_oklab,var(--color-accent-300),transparent_80%)] text-[var(--color-accent-300)] ring-[var(--color-accent-300)]"
                          : "bg-[var(--color-bg-900)] text-[var(--color-fg-300)] ring-[var(--color-border-default)] hover:text-[var(--color-fg-50)]",
                      )}
                      aria-pressed={selected}
                    >
                      {p.display_name_en}
                    </button>
                  );
                })}
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
            {saving ? "Saving…" : "Save changes"}
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

function BilingualSection({
  title,
  enLabel,
  esLabel,
  enValue,
  esValue,
  onEnChange,
  onEsChange,
  placeholder,
  multiline,
}: {
  title: string;
  enLabel: string;
  esLabel: string;
  enValue: string;
  esValue: string;
  onEnChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onEsChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const esMissing = enValue.trim().length > 0 && esValue.trim().length === 0;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-500)]">
          {title}
        </h4>
        {esMissing ? (
          <Chip tone="danger" className="gap-0.5">
            <Languages className="h-3 w-3" aria-hidden /> ES needed
          </Chip>
        ) : null}
      </div>
      <Field label={enLabel}>
        {multiline ? (
          <Textarea value={enValue} onChange={onEnChange} placeholder={placeholder} rows={5} />
        ) : (
          <Input value={enValue} onChange={onEnChange} placeholder={placeholder} />
        )}
      </Field>
      <Field label={esLabel}>
        {multiline ? (
          <Textarea value={esValue} onChange={onEsChange} placeholder="Traducción al español…" rows={5} />
        ) : (
          <Input value={esValue} onChange={onEsChange} placeholder="Traducción al español…" />
        )}
      </Field>
    </section>
  );
}
