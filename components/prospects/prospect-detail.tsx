"use client";

import type { Route } from "next";

import {
  Activity,
  ArrowLeft,
  Brain,
  ChevronDown,
  Clipboard,
  ExternalLink,
  Gauge,
  Globe,
  Loader2,
  Mail,
  MessageSquareWarning,
  Plus,
  Save,
  ScanSearch,
  Search,
  Sparkles,
  Trash2,
  UserCheck,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { TagInput } from "@/components/ui/tag-input";
import { Textarea } from "@/components/ui/textarea";
import {
  transitionStatus,
  updateProspect,
  upsertManualContact,
  upsertResearch,
} from "@/lib/prospects/detail-actions";
import type {
  ActivityEntry,
  PainOption,
  PainPoint,
  ProspectFull,
  ProspectResearch,
} from "@/lib/prospects/detail-queries";
import { scrapeWebsite } from "@/lib/research/scrape-action";
import { scoreProspect } from "@/lib/research/score-action";
import { runStructuredResearch } from "@/lib/research/structured-research-action";
import { deepResearchProspect } from "@/lib/research/deep-research-action";
import { buildDeepResearchPrompt } from "@/lib/research/deep-research-prompt";
import { generatePitch } from "@/lib/pitches/actions";
import { reEnrichProspectContacts } from "@/lib/discover/pipeline-action";
import { cn, relativeTime } from "@/lib/utils";

interface ProspectDetailProps {
  prospect: ProspectFull;
  research: ProspectResearch | null;
  activity: ActivityEntry[];
  painOptions: PainOption[];
  researchTableMissing: boolean;
  canEdit: boolean;
  topContactEmail: string | null;
  topContactIsRoleBased: boolean;
}

type Tab = "overview" | "research" | "activity";

const STATUS_OPTIONS = [
  "raw",
  "researched",
  "pitched",
  "replied",
  "booked",
  "won",
  "lost",
  "suppressed",
] as const;
type StatusValue = (typeof STATUS_OPTIONS)[number];

const STATUS_TONE: Record<string, "info" | "neutral" | "success" | "danger" | "warning"> = {
  raw: "neutral",
  researched: "info",
  pitched: "info",
  replied: "info",
  meeting_booked: "success",
  won: "success",
  lost: "danger",
  suppressed: "warning",
};

const TERMINAL_STATUSES = new Set<StatusValue>(["won", "lost", "suppressed"]);

const MARKET_FLAG: Record<"CA" | "MX" | "US" | "LATAM", string> = {
  CA: "🇨🇦",
  MX: "🇲🇽",
  US: "🇺🇸",
  LATAM: "🌎",
};

export function ProspectDetail({
  prospect,
  research,
  activity,
  painOptions,
  researchTableMissing,
  canEdit,
  topContactEmail,
  topContactIsRoleBased,
}: ProspectDetailProps) {
  const [tab, setTab] = React.useState<Tab>("overview");

  return (
    <div className="flex h-full flex-col">
      <DetailHeader prospect={prospect} canEdit={canEdit} />

      <nav className="flex shrink-0 items-center gap-4 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-900)] px-4">
        <TabButton
          active={tab === "overview"}
          onClick={() => setTab("overview")}
          label="Overview"
        />
        <TabButton
          active={tab === "research"}
          onClick={() => setTab("research")}
          label="Research"
          badge={research ? "•" : null}
        />
        <TabButton
          active={tab === "activity"}
          onClick={() => setTab("activity")}
          label="Activity"
          badge={activity.length > 0 ? String(activity.length) : null}
        />
      </nav>

      <div className="flex-1 overflow-y-auto">
        {tab === "overview" ? (
          <OverviewTab prospect={prospect} canEdit={canEdit} topContactEmail={topContactEmail} />
        ) : null}
        {tab === "research" ? (
          <ResearchTab
            // Remount when research.updated_at changes (e.g. after a scrape
            // triggers router.refresh()) so the form re-initializes from the
            // latest server values instead of holding stale local state.
            key={research?.updated_at ?? "no-research"}
            prospect={prospect}
            research={research}
            painOptions={painOptions}
            researchTableMissing={researchTableMissing}
            canEdit={canEdit}
            topContactEmail={topContactEmail}
            topContactIsRoleBased={topContactIsRoleBased}
          />
        ) : null}
        {tab === "activity" ? <ActivityTab activity={activity} /> : null}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-11 items-center gap-1.5 border-b-2 px-0.5 text-[11px] font-medium tracking-tight",
        "-mb-px transition-[color,border-color]",
        "duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
        active
          ? "border-[var(--color-accent-300)] text-[var(--color-fg-50)]"
          : "border-transparent text-[var(--color-fg-500)] hover:text-[var(--color-fg-50)]",
      )}
    >
      {label}
      {badge ? (
        <span className="rounded-[var(--radius-sm)] bg-[var(--color-bg-700)] px-1 text-[10px] text-[var(--color-fg-500)]">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function DetailHeader({ prospect, canEdit }: { prospect: ProspectFull; canEdit: boolean }) {
  const router = useRouter();
  const [pendingStatus, setPendingStatus] = React.useState<StatusValue | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const handleStatusChange = (next: StatusValue) => {
    setError(null);
    if (next === prospect.status) return;
    if (TERMINAL_STATUSES.has(next)) {
      setPendingStatus(next);
      setConfirmOpen(true);
      return;
    }
    applyStatus(next);
  };

  const applyStatus = (next: StatusValue, reason?: string) => {
    startTransition(async () => {
      const result = await transitionStatus({
        id: prospect.id,
        next_status: next,
        suppressed_reason: reason ?? null,
      });
      if (!result.ok) {
        setError(result.error);
      } else {
        router.refresh();
      }
      setConfirmOpen(false);
      setPendingStatus(null);
    });
  };

  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-[var(--color-border-subtle)] px-4 pt-3 pb-3">
      <div className="flex items-center gap-2 text-[11px] text-[var(--color-fg-500)]">
        <Link
          href="/companies"
          className="inline-flex items-center gap-1 hover:text-[var(--color-fg-50)]"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden /> Companies
        </Link>
        <span className="text-[var(--color-fg-700)]">/</span>
        <span className="font-mono text-xs">{prospect.id.slice(0, 8)}</span>
      </div>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-[var(--color-fg-50)]">
            <span aria-hidden>{MARKET_FLAG[prospect.market]}</span>
            <span className="truncate">{prospect.company_name}</span>
          </h1>
          {prospect.domain ? (
            <a
              href={prospect.website_url ?? `https://${prospect.domain}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-1 font-mono text-[11px] text-[var(--color-fg-500)] hover:text-[var(--color-accent-300)]"
            >
              <Globe className="h-3 w-3" aria-hidden /> {prospect.domain}
              <ExternalLink className="h-2.5 w-2.5" aria-hidden />
            </a>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip tone={STATUS_TONE[prospect.status] ?? "neutral"}>{prospect.status}</Chip>
            {prospect.icp_name ? <Chip tone="accent">ICP: {prospect.icp_name}</Chip> : null}
            <Chip tone="neutral">
              {prospect.discovery_source.replace(/_/g, " ")}
            </Chip>
            {prospect.match_score !== null ? (
              <Chip tone={prospect.match_score >= 70 ? "success" : "neutral"}>
                Score {prospect.match_score}
              </Chip>
            ) : null}
            {prospect.red_flags.map((f) => (
              <Chip key={f} tone="warning" className="gap-1">
                <MessageSquareWarning className="h-3 w-3" aria-hidden />
                {f.replace(/_/g, " ")}
              </Chip>
            ))}
          </div>
        </div>
        {canEdit ? (
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Label className="text-[10px] text-[var(--color-fg-700)]">Status</Label>
            <div className="relative inline-flex items-center">
              <Select
                value={prospect.status}
                onChange={(e) => handleStatusChange(e.target.value as StatusValue)}
                disabled={pending}
                className="h-8 max-w-[180px] py-0 pr-7 text-xs"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
              {pending ? (
                <Loader2 className="pointer-events-none absolute right-7 h-3 w-3 animate-spin text-[var(--color-fg-500)]" aria-hidden />
              ) : null}
            </div>
            {error ? (
              <p className="text-[10px] text-[var(--color-danger-300)]">{error}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {pendingStatus ? (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={(open) => {
            if (!open) {
              setConfirmOpen(false);
              setPendingStatus(null);
            }
          }}
          title={`Move ${prospect.company_name} to "${pendingStatus}"?`}
          description={
            pendingStatus === "suppressed"
              ? "Suppressed prospects are excluded from all future discovery, scoring, and pitching for this tenant."
              : pendingStatus === "won"
                ? "Marks the deal as closed-won. They drop out of the active outreach pipeline."
                : "Marks the deal as closed-lost. They drop out of the active outreach pipeline."
          }
          confirmLabel={`Move to ${pendingStatus}`}
          variant={pendingStatus === "won" ? "primary" : "danger"}
          onConfirm={() => applyStatus(pendingStatus)}
          pending={pending}
        />
      ) : null}
    </header>
  );
}

function OverviewTab({
  prospect,
  canEdit,
  topContactEmail,
}: {
  prospect: ProspectFull;
  canEdit: boolean;
  topContactEmail: string | null;
}) {
  const [companyName, setCompanyName] = React.useState(prospect.company_name);
  const [domain, setDomain] = React.useState(prospect.domain ?? "");
  const [websiteUrl, setWebsiteUrl] = React.useState(prospect.website_url ?? "");
  const [industry, setIndustry] = React.useState(prospect.industry ?? "");
  const [employees, setEmployees] = React.useState(
    prospect.employee_size_estimate?.toString() ?? "",
  );
  const [city, setCity] = React.useState(prospect.city ?? "");
  const [region, setRegion] = React.useState(prospect.region ?? "");
  const [matchScore, setMatchScore] = React.useState(
    prospect.match_score?.toString() ?? "",
  );
  const [contactEmail, setContactEmail] = React.useState(topContactEmail ?? "");
  // Always sync from server — topContactEmail only changes when the DB changes
  // (scrape, manual save), so overwriting local state is the correct behaviour.
  React.useEffect(() => {
    setContactEmail(topContactEmail ?? "");
  }, [topContactEmail]);
  const [contactStatus, setContactStatus] = React.useState<"idle" | "saved" | { error: string }>("idle");
  const [savingContact, startSaveContact] = React.useTransition();
  const [status, setStatus] = React.useState<"idle" | "saved" | { error: string }>("idle");
  const [saving, startSave] = React.useTransition();

  const handleSave = () => {
    setStatus("idle");
    startSave(async () => {
      const score = matchScore.trim() === "" ? null : Number.parseInt(matchScore, 10);
      const employeeNum = employees.trim() === "" ? null : Number.parseInt(employees, 10);
      const result = await updateProspect({
        id: prospect.id,
        company_name: companyName,
        domain: domain.trim() || null,
        website_url: websiteUrl.trim() || null,
        industry: industry.trim() || null,
        employee_size_estimate: employeeNum,
        city: city.trim() || null,
        region: region.trim() || null,
        match_score: score,
      });
      if (result.ok) {
        setStatus("saved");
        setTimeout(() => setStatus("idle"), 2000);
      } else {
        setStatus({ error: result.error });
      }
    });
  };

  const handleSaveContact = () => {
    if (!contactEmail.trim()) return;
    setContactStatus("idle");
    startSaveContact(async () => {
      const result = await upsertManualContact(prospect.id, contactEmail.trim());
      if (result.ok) {
        setContactStatus("saved");
        setTimeout(() => setContactStatus("idle"), 2000);
      } else {
        setContactStatus({ error: result.error });
      }
    });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6 p-4">
      <Section title="Company info">
        <Field label="Company name">
          <Input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            disabled={!canEdit}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Domain">
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
              disabled={!canEdit}
            />
          </Field>
          <Field label="Website URL">
            <Input
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              placeholder="https://example.com"
              disabled={!canEdit}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Industry">
            <Input
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="Coffee roaster"
              disabled={!canEdit}
            />
          </Field>
          <Field label="Employees (estimate)">
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              value={employees}
              onChange={(e) => setEmployees(e.target.value)}
              placeholder="25"
              disabled={!canEdit}
            />
          </Field>
        </div>
        <Field label="Contact email">
          <div className="flex gap-2">
            <Input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="owner@example.com"
              disabled={!canEdit}
              className="flex-1"
            />
            {canEdit ? (
              <Button
                type="button"
                variant="secondary"
                onClick={handleSaveContact}
                disabled={savingContact || !contactEmail.trim()}
              >
                {savingContact ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : contactStatus === "saved" ? (
                  "Saved"
                ) : (
                  "Save"
                )}
              </Button>
            ) : null}
          </div>
          {typeof contactStatus === "object" ? (
            <p className="mt-1 text-xs text-[var(--color-danger-300)]">{contactStatus.error}</p>
          ) : null}
          <p className="mt-1 text-[11px] text-[var(--color-fg-700)]">
            Used as the To: address when generating pitches. Overrides scraper-found emails.
          </p>
        </Field>
      </Section>

      <Section title="Location">
        <div className="grid grid-cols-2 gap-3">
          <Field label="City">
            <Input value={city} onChange={(e) => setCity(e.target.value)} disabled={!canEdit} />
          </Field>
          <Field label="Region / Province">
            <Input value={region} onChange={(e) => setRegion(e.target.value)} disabled={!canEdit} />
          </Field>
        </div>
        <p className="text-[11px] text-[var(--color-fg-700)]">
          Market is set at discovery time and not editable here. Currently:{" "}
          <span className="font-medium text-[var(--color-fg-300)]">{prospect.market}</span>
        </p>
      </Section>

      <Section
        title="Scoring"
        description="0–100. Set manually now; Phase 2 will auto-score with Claude using the rubric in tasks/."
      >
        <Field label="Match score">
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            value={matchScore}
            onChange={(e) => setMatchScore(e.target.value)}
            placeholder="—"
            disabled={!canEdit}
            className="max-w-[140px]"
          />
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
            Last updated {relativeTime(prospect.updated_at)}
          </span>
        )}
        {canEdit ? (
          <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Save className="h-3.5 w-3.5" aria-hidden />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ResearchTab({
  prospect,
  research,
  painOptions,
  researchTableMissing,
  canEdit,
  topContactEmail,
  topContactIsRoleBased,
}: {
  prospect: ProspectFull;
  research: ProspectResearch | null;
  painOptions: PainOption[];
  researchTableMissing: boolean;
  canEdit: boolean;
  topContactEmail: string | null;
  topContactIsRoleBased: boolean;
}) {
  const [whatTheyDo, setWhatTheyDo] = React.useState(research?.what_they_do ?? "");
  const [techStack, setTechStack] = React.useState<string[]>(research?.tech_stack ?? []);
  const [painPoints, setPainPoints] = React.useState<PainPoint[]>(research?.pain_points ?? []);
  const [notes, setNotes] = React.useState(research?.notes ?? "");
  const [evidenceUrls, setEvidenceUrls] = React.useState<string[]>(
    research?.evidence_urls ?? [],
  );
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saved" | { error: string }>(
    "idle",
  );
  const [saving, startSave] = React.useTransition();
  const router = useRouter();
  const [scrapeMessage, setScrapeMessage] = React.useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [scraping, startScrape] = React.useTransition();
  const [scoreMessage, setScoreMessage] = React.useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [scoring, startScore] = React.useTransition();
  const [researchMessage, setResearchMessage] = React.useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [researching, startResearch] = React.useTransition();
  const [pitchMessage, setPitchMessage] = React.useState<{ tone: "ok" | "warn"; text: string; pitchId?: string } | null>(null);
  const [generatingPitch, startPitch] = React.useTransition();
  const [deepResearchMessage, setDeepResearchMessage] = React.useState<{ tone: "ok" | "warn"; text: string; score?: number; showPitchButton?: boolean } | null>(null);
  const [deepResearching, startDeepResearch] = React.useTransition();
  const [deepResearchRaw, setDeepResearchRaw] = React.useState<string | null>(null);
  const [deepResearchExpanded, setDeepResearchExpanded] = React.useState(false);
  const [copyPromptDone, setCopyPromptDone] = React.useState(false);
  const [enrichMessage, setEnrichMessage] = React.useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [enriching, startEnrich] = React.useTransition();

  // ── Phase-completion flags — derived from already-loaded data ──────────────
  // Drive the button labels ("Run X" vs "Re-run X") + a subtle done marker so
  // you can tell whether clicking re-runs a phase or runs it for the first time.
  const scrapeDone = !!research?.last_scraped_at;
  const deepResearchDone = research?.research_method === "claude_assisted";
  const structuredResearchDone =
    (research?.pain_points?.length ?? 0) > 0 &&
    !!research?.pain_points?.some((p) => p.pain_id || p.evidence_quote);
  const scoreDone = prospect.match_score != null;
  const contactsDone = !!topContactEmail;

  if (researchTableMissing) {
    return (
      <div className="m-4 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-default)] bg-[var(--color-bg-900)] p-6">
        <h3 className="text-sm font-medium text-[var(--color-fg-50)]">
          Research table not yet created
        </h3>
        <p className="mt-2 text-xs text-[var(--color-fg-500)]">
          Apply migration{" "}
          <code className="font-mono text-[var(--color-accent-300)]">
            supabase/migrations/0004_prospect_research.sql
          </code>{" "}
          via the Supabase SQL editor:
        </p>
        <ol className="mt-3 list-inside list-decimal space-y-1 text-xs text-[var(--color-fg-500)]">
          <li>
            Open{" "}
            <a
              href="https://supabase.com/dashboard/project/ybbrpqzbedaxsmotgtkh/sql/new"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-accent-300)] underline-offset-4 hover:underline"
            >
              the SQL editor
            </a>
          </li>
          <li>
            Paste the SQL from{" "}
            <code className="font-mono">supabase/migrations/0004_prospect_research.sql</code>
          </li>
          <li>Click <strong>Run</strong> and refresh this page</li>
        </ol>
      </div>
    );
  }

  const handleSave = () => {
    setSaveStatus("idle");
    startSave(async () => {
      const result = await upsertResearch({
        prospect_id: prospect.id,
        what_they_do: whatTheyDo.trim() || null,
        tech_stack: techStack,
        pain_points: painPoints,
        notes: notes.trim() || null,
        evidence_urls: evidenceUrls,
      });
      if (result.ok) {
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 2000);
      } else {
        setSaveStatus({ error: result.error });
      }
    });
  };

  const handleGeneratePitch = () => {
    setPitchMessage(null);
    startPitch(async () => {
      const res = await generatePitch(prospect.id);
      if (res.ok) {
        setPitchMessage({
          tone: "ok",
          text: `Draft pitch ready (self-score ${Math.round(res.quality_self_score * 100)}%, ${res.method}). ${res.reasoning}`,
          pitchId: res.pitch_id,
        });
      } else {
        setPitchMessage({ tone: "warn", text: res.error });
      }
    });
  };

  const handleStructuredResearch = () => {
    setResearchMessage(null);
    startResearch(async () => {
      const result = await runStructuredResearch(prospect.id);
      if (result.ok) {
        setResearchMessage({
          tone: "ok",
          text: `${result.method === "claude" ? "Claude" : "Heuristic"} research: +${result.pain_points_added} pain${result.pain_points_added === 1 ? "" : "s"}, +${result.contacts_added} contact${result.contacts_added === 1 ? "" : "s"}. ${result.reasoning}`,
        });
        router.refresh();
      } else {
        setResearchMessage({ tone: "warn", text: result.error });
      }
    });
  };

  const handleScore = () => {
    setScoreMessage(null);
    startScore(async () => {
      const result = await scoreProspect(prospect.id);
      if (result.ok) {
        setScoreMessage({
          tone: "ok",
          text: `Scored ${result.composite_score}/100 (${(result.confidence * 100).toFixed(0)}% confidence, ${result.method}). ${result.reasoning}`,
        });
        router.refresh();
      } else {
        setScoreMessage({ tone: "warn", text: result.error });
      }
    });
  };

  const handleScrape = () => {
    setScrapeMessage(null);
    startScrape(async () => {
      const result = await scrapeWebsite(prospect.id);
      if (result.ok) {
        const parts = [
          result.what_they_do_set ? "what_they_do filled" : null,
          result.tech_count > 0 ? `${result.tech_count} tech detected` : null,
          result.emails_count > 0
            ? `${result.emails_count} email${result.emails_count === 1 ? "" : "s"} found`
            : null,
          result.contact_insert_errors.length > 0
            ? `⚠ contact save failed: ${result.contact_insert_errors[0]}`
            : null,
        ].filter(Boolean);
        setScrapeMessage({
          tone: result.contact_insert_errors.length > 0 ? "warn" : "ok",
          text: parts.length > 0 ? `Scraped: ${parts.join(", ")}.` : "Scraped (no new fields).",
        });
        router.refresh();
      } else {
        // Refresh so pain points and status changes render.
        if (result.pain_point_added) router.refresh();
        setScrapeMessage({ tone: "warn", text: result.error });
      }
    });
  };

  const handleDeepResearch = () => {
    setDeepResearchMessage(null);
    setDeepResearchRaw(null);
    setDeepResearchExpanded(false);
    startDeepResearch(async () => {
      const result = await deepResearchProspect(prospect.id);
      if (result.ok) {
        const parts = [
          result.what_they_do ? "snapshot captured" : null,
          result.pain_points_added > 0 ? `${result.pain_points_added} pain point${result.pain_points_added === 1 ? "" : "s"}` : null,
          result.contact_found ? `contact: ${result.contact_found}` : null,
          `$${result.cost_usd.toFixed(3)}`,
        ].filter(Boolean);
        setDeepResearchMessage({
          tone: "ok",
          text: `Score: ${result.score}/100 — ${parts.join(" · ")}`,
          score: result.score,
          showPitchButton: result.score >= 70,
        });
        setDeepResearchRaw(result.raw_response);
        router.refresh();
      } else {
        setDeepResearchMessage({ tone: "warn", text: result.error });
      }
    });
  };

  const handleCopyPrompt = () => {
    const targetUrl =
      prospect.website_url ??
      (prospect.domain ? `https://${prospect.domain}` : "");
    const prompt = buildDeepResearchPrompt(prospect.company_name, targetUrl);
    navigator.clipboard.writeText(prompt).then(() => {
      setCopyPromptDone(true);
      setTimeout(() => setCopyPromptDone(false), 2000);
    });
  };

  const handleReEnrichContacts = () => {
    setEnrichMessage(null);
    startEnrich(async () => {
      const result = await reEnrichProspectContacts(prospect.id);
      if (!result.ok) {
        setEnrichMessage({ tone: "warn", text: result.error });
        return;
      }
      if (result.found) {
        setEnrichMessage({
          tone: "ok",
          text: `Found: ${result.email} (${result.method})`,
        });
        router.refresh();
      } else {
        setEnrichMessage({ tone: "warn", text: "All tiers exhausted — no contact found." });
      }
    });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-lg)] bg-[var(--color-bg-800)] p-4 ring-1 ring-inset ring-[var(--color-border-default)]">
        <div className="flex min-w-[160px] flex-1 flex-col">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-500)]">
            Auto research
          </span>
          <p className="mt-1 text-xs text-[var(--color-fg-300)]">
            Pull what_they_do, tech indicators, and contact links straight from
            the prospect's site. Output gets written into the fields below.
          </p>
          {scrapeMessage ? (
            <p
              className={cn(
                "mt-2 text-[11px] italic",
                scrapeMessage.tone === "ok"
                  ? "text-[var(--color-success-300)]"
                  : "text-[var(--color-warning-300)]",
              )}
            >
              {scrapeMessage.text}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={handleScrape}
            disabled={scraping || !canEdit || !prospect.domain}
          >
            {scraping ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <ScanSearch className="h-3.5 w-3.5" aria-hidden />
            )}
            {scraping ? "Scraping…" : scrapeDone ? "Re-scrape website" : "Scrape website"}
            {scrapeDone && !scraping ? (
              <span className="ml-auto text-[10px] text-[var(--color-success-300)]" title="Already run">✓</span>
            ) : null}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={handleStructuredResearch}
            disabled={researching || !canEdit}
            title="Classify pain points against the taxonomy + pick a decision-maker contact"
          >
            {researching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Brain className="h-3.5 w-3.5" aria-hidden />
            )}
            {researching ? "Researching…" : structuredResearchDone ? "Re-run structured research" : "Run structured research"}
            {structuredResearchDone && !researching ? (
              <span className="ml-auto text-[10px] text-[var(--color-success-300)]" title="Already run">✓</span>
            ) : null}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={handleReEnrichContacts}
            disabled={enriching || !canEdit || !prospect.domain}
            title="Re-run SnapVerify → Anymail → Hunter contact waterfall for this prospect"
          >
            {enriching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <UserCheck className="h-3.5 w-3.5" aria-hidden />
            )}
            {enriching ? "Finding contact…" : "Re-enrich contacts"}
            {contactsDone && !enriching ? (
              <span className="ml-auto text-[10px] text-[var(--color-success-300)]" title="Contact found">✓</span>
            ) : null}
          </Button>
          {enrichMessage ? (
            <p
              className={cn(
                "text-[11px] italic",
                enrichMessage.tone === "ok"
                  ? "text-[var(--color-success-300)]"
                  : "text-[var(--color-warning-300)]",
              )}
            >
              {enrichMessage.text}
            </p>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            onClick={handleScore}
            disabled={scoring || !canEdit}
            title="Score this prospect against its ICP rubric"
          >
            {scoring ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Gauge className="h-3.5 w-3.5" aria-hidden />
            )}
            {scoring ? "Scoring…" : scoreDone ? "Re-score prospect" : "Score prospect"}
            {scoreDone && !scoring ? (
              <span className="ml-auto text-[10px] text-[var(--color-success-300)]" title="Already scored">✓</span>
            ) : null}
          </Button>
          <div className="flex items-stretch gap-1">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={handleDeepResearch}
              disabled={deepResearching || !canEdit || (!prospect.domain && !prospect.website_url)}
              title="Scrape + 3 Brave searches + Claude-sonnet synthesis → fills research fields, auto-scores"
            >
              {deepResearching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
              )}
              {deepResearching ? "Researching…" : deepResearchDone ? "Re-run Deep Research" : "Deep Research"}
              {deepResearchDone && !deepResearching ? (
                <span className="ml-auto text-[10px] text-[var(--color-success-300)]" title="Already run">✓</span>
              ) : null}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="px-2"
              onClick={handleCopyPrompt}
              disabled={!prospect.domain && !prospect.website_url}
              title="Copy Pedro's research prompt to clipboard (for manual use in Claude.ai)"
            >
              {copyPromptDone ? (
                <span className="text-[10px] text-[var(--color-success-300)]">✓</span>
              ) : (
                <Clipboard className="h-3.5 w-3.5" aria-hidden />
              )}
            </Button>
          </div>
          {topContactEmail && topContactIsRoleBased ? (
            <p className="text-[11px] text-[var(--color-warning-300)]">
              ⚠ Role-based email ({topContactEmail}) — pitch will include a forwarding ask. Add a personal email in Overview for better results.
            </p>
          ) : !topContactEmail ? (
            <p className="text-[11px] text-[var(--color-warning-300)]">
              ⚠ No contact email — scrape the website or add one in Overview first.
            </p>
          ) : null}
          <Button
            type="button"
            variant="primary"
            onClick={handleGeneratePitch}
            disabled={generatingPitch || !canEdit}
            title="Compose a cold-outreach email pitch using research + ICP fit + a matched case study"
          >
            {generatingPitch ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Mail className="h-3.5 w-3.5" aria-hidden />
            )}
            {generatingPitch ? "Composing…" : "Generate pitch"}
          </Button>
        </div>
      </div>
      {pitchMessage ? (
        <p
          className={cn(
            "-mt-3 text-[11px] italic",
            pitchMessage.tone === "ok"
              ? "text-[var(--color-success-300)]"
              : "text-[var(--color-warning-300)]",
          )}
        >
          {pitchMessage.text}
          {pitchMessage.pitchId ? (
            <>
              {" "}
              <Link
                href={"/pitches" as Route}
                className="font-medium text-[var(--color-accent-300)] hover:underline"
              >
                Open in /pitches →
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {scoreMessage ? (
        <p
          className={cn(
            "-mt-3 text-[11px] italic",
            scoreMessage.tone === "ok"
              ? "text-[var(--color-success-300)]"
              : "text-[var(--color-warning-300)]",
          )}
        >
          {scoreMessage.text}
        </p>
      ) : null}
      {researchMessage ? (
        <p
          className={cn(
            "-mt-3 text-[11px] italic",
            researchMessage.tone === "ok"
              ? "text-[var(--color-success-300)]"
              : "text-[var(--color-warning-300)]",
          )}
        >
          {researchMessage.text}
        </p>
      ) : null}
      {deepResearchMessage ? (
        <div className="-mt-3 flex flex-col gap-2">
          <p
            className={cn(
              "text-[11px] italic",
              deepResearchMessage.tone === "ok"
                ? "text-[var(--color-success-300)]"
                : "text-[var(--color-warning-300)]",
            )}
          >
            {deepResearchMessage.text}
          </p>
          {deepResearchMessage.showPitchButton && (
            <Button
              type="button"
              variant="primary"
              onClick={handleGeneratePitch}
              disabled={generatingPitch || !canEdit}
              className="self-start"
            >
              <Mail className="h-3.5 w-3.5" aria-hidden />
              Generate pitch now →
            </Button>
          )}
          {deepResearchRaw && (
            <div>
              <button
                type="button"
                onClick={() => setDeepResearchExpanded((v) => !v)}
                className="flex items-center gap-1 text-[10px] text-[var(--color-fg-500)] hover:text-[var(--color-fg-300)]"
              >
                <ChevronDown
                  className={cn(
                    "h-3 w-3 transition-transform",
                    deepResearchExpanded ? "rotate-180" : "",
                  )}
                  aria-hidden
                />
                {deepResearchExpanded ? "Hide" : "Show"} Claude's full analysis
              </button>
              {deepResearchExpanded && (
                <pre className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-bg-900)] p-3 font-mono text-[10px] leading-relaxed text-[var(--color-fg-400)] ring-1 ring-inset ring-[var(--color-border-subtle)]">
                  {deepResearchRaw}
                </pre>
              )}
            </div>
          )}
        </div>
      ) : null}

      <Section
        title="What they do"
        description="One paragraph describing the company's product, service, and audience. Cite the source URL in evidence."
      >
        <Textarea
          value={whatTheyDo}
          onChange={(e) => setWhatTheyDo(e.target.value)}
          rows={4}
          disabled={!canEdit}
          placeholder="Calgary-based DTC coffee roaster selling subscription beans nationally. Shopify storefront, sells through their site + a small wholesale arm…"
        />
      </Section>

      <Section
        title="Tech stack"
        description="Detected platforms, marketing tools, frameworks. Tag pills."
      >
        <TagInput
          value={techStack}
          onChange={canEdit ? setTechStack : () => {}}
          placeholder="Shopify, Klaviyo, Recharge…"
        />
      </Section>

      <Section
        title="Pain points"
        description="Add the pains this prospect probably has + an evidence quote or URL where you saw it."
      >
        <PainPointEditor
          value={painPoints}
          onChange={setPainPoints}
          options={painOptions}
          disabled={!canEdit}
        />
      </Section>

      <Section title="Free-form notes">
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={5}
          disabled={!canEdit}
          placeholder="Anything else worth remembering. Links, recent news, founder background…"
        />
      </Section>

      <Section title="Evidence URLs">
        <TagInput
          value={evidenceUrls}
          onChange={canEdit ? setEvidenceUrls : () => {}}
          placeholder="https://example.com/about"
        />
      </Section>

      <div className="flex items-center gap-2 border-t border-[var(--color-border-subtle)] pt-4">
        {saveStatus === "saved" ? (
          <Chip tone="success" className="mr-auto">
            Saved
          </Chip>
        ) : typeof saveStatus === "object" ? (
          <p className="mr-auto text-xs text-[var(--color-danger-300)]">{saveStatus.error}</p>
        ) : research ? (
          <span className="mr-auto text-[11px] text-[var(--color-fg-700)]">
            Last edited {relativeTime(research.updated_at)}
            {research.last_edited_by_name ? ` by ${research.last_edited_by_name}` : ""}
          </span>
        ) : (
          <span className="mr-auto text-[11px] text-[var(--color-fg-700)]">
            No research saved yet.
          </span>
        )}
        {canEdit ? (
          <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Save className="h-3.5 w-3.5" aria-hidden />}
            {saving ? "Saving…" : "Save research"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function PainPointEditor({
  value,
  onChange,
  options,
  disabled,
}: {
  value: PainPoint[];
  onChange: (next: PainPoint[]) => void;
  options: PainOption[];
  disabled: boolean;
}) {
  const optionById = React.useMemo(
    () => new Map(options.map((o) => [o.id, o])),
    [options],
  );
  // Pain ids already used in this editor — disable in dropdowns to prevent
  // duplicates (Phase 2 aggregator will assume one entry per pain code).
  const usedIds = React.useMemo(
    () => new Set(value.map((p) => p.pain_id).filter(Boolean) as string[]),
    [value],
  );

  const update = (i: number, patch: Partial<PainPoint>) => {
    onChange(value.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  };
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const add = () => onChange([...value, { evidence_quote: "" }]);

  const pickPain = (i: number, painId: string) => {
    if (!painId) {
      // Reset to empty selection
      update(i, { pain_id: undefined, pain_label: undefined });
      return;
    }
    const opt = optionById.get(painId);
    if (!opt) return;
    update(i, { pain_id: opt.id, pain_label: opt.display_name });
  };

  if (options.length === 0) {
    return (
      <p className="text-xs italic text-[var(--color-fg-700)]">
        Pain taxonomy is empty. Run <code>supabase/seed.sql</code> to seed canonical pains.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 ? (
        <p className="text-xs italic text-[var(--color-fg-700)]">No pain points yet.</p>
      ) : (
        value.map((p, i) => {
          const selectedOpt = p.pain_id ? optionById.get(p.pain_id) : undefined;
          // Legacy entries may have a pain_label without a pain_id (pre–slice 2).
          const isLegacy = !p.pain_id && Boolean(p.pain_label);
          return (
            <div
              key={i}
              className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-[var(--color-bg-900)] p-3 ring-1 ring-inset ring-[var(--color-border-default)]"
            >
              <div className="flex gap-2">
                <Select
                  value={p.pain_id ?? ""}
                  onChange={(e) => pickPain(i, e.target.value)}
                  disabled={disabled}
                  aria-label="Pain"
                >
                  <option value="">Select a pain…</option>
                  {options.map((opt) => {
                    const isUsedByOther = usedIds.has(opt.id) && opt.id !== p.pain_id;
                    return (
                      <option key={opt.id} value={opt.id} disabled={isUsedByOther}>
                        {opt.display_name}
                        {isUsedByOther ? " (already added)" : ""}
                      </option>
                    );
                  })}
                </Select>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  disabled={disabled}
                  className={cn(
                    "grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-md)]",
                    "text-[var(--color-fg-500)] hover:bg-[var(--color-bg-700)] hover:text-[var(--color-danger-300)]",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-300)]",
                    "disabled:opacity-40 disabled:pointer-events-none",
                  )}
                  aria-label="Remove pain point"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
              {selectedOpt?.description ? (
                <p className="text-[11px] text-[var(--color-fg-500)]">
                  {selectedOpt.description}
                </p>
              ) : null}
              {isLegacy ? (
                <p className="text-[11px] text-[var(--color-warning-300)]">
                  Legacy free-text label “{p.pain_label}” — pick a canonical pain to upgrade.
                </p>
              ) : null}
              <Textarea
                value={p.evidence_quote ?? ""}
                onChange={(e) => update(i, { evidence_quote: e.target.value })}
                placeholder="Evidence quote from the site / LinkedIn"
                rows={2}
                disabled={disabled}
              />
              <Input
                value={p.evidence_url ?? ""}
                onChange={(e) => update(i, { evidence_url: e.target.value })}
                placeholder="Evidence URL"
                disabled={disabled}
              />
            </div>
          );
        })
      )}
      {!disabled ? (
        <Button type="button" size="sm" variant="secondary" onClick={add}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add pain point
        </Button>
      ) : null}
    </div>
  );
}

function ActivityIcon({ kind }: { kind: ActivityEntry["kind"] }) {
  const cls = "h-3.5 w-3.5 text-[var(--color-accent-300)]";
  switch (kind) {
    case "discovery":
      return <Search className={cls} aria-hidden />;
    case "research_edit":
    case "research_create":
      return <ScanSearch className={cls} aria-hidden />;
    case "scrape":
      return <Globe className={cls} aria-hidden />;
    case "score":
      return <Gauge className={cls} aria-hidden />;
    case "status_change":
      return <ChevronDown className={cls} aria-hidden />;
    case "update":
    default:
      return <Activity className={cls} aria-hidden />;
  }
}

function ActivityTab({ activity }: { activity: ActivityEntry[] }) {
  if (activity.length === 0) {
    return (
      <div className="m-4 text-xs italic text-[var(--color-fg-700)]">
        No activity recorded yet.
      </div>
    );
  }
  return (
    <ol className="m-4 flex flex-col gap-3">
      {activity.map((a) => (
        <li
          key={a.id}
          className="flex gap-3 rounded-[var(--radius-md)] bg-[var(--color-bg-800)] p-3 ring-1 ring-inset ring-[var(--color-border-default)]"
        >
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--color-bg-900)] ring-1 ring-inset ring-[var(--color-border-default)]">
            <ActivityIcon kind={a.kind} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--color-fg-50)]">{a.label}</span>
              <span className="text-[11px] text-[var(--color-fg-500)]">{relativeTime(a.at)}</span>
            </div>
            {a.detail ? (
              <span className="text-[11px] text-[var(--color-fg-500)]">{a.detail}</span>
            ) : null}
            {a.actor_name ? (
              <span className="text-[11px] text-[var(--color-fg-700)]">by {a.actor_name}</span>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
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

// Suppress unused import warning for ChevronDown (used by Select internally)
void ChevronDown;
