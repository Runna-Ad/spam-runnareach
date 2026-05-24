/**
 * Client-safe type definitions for prompts — no server imports here.
 * Client components import from this file; queries.ts is server-only.
 */
import type { Database } from "@/lib/supabase/types";

export type PromptPurpose = Database["public"]["Tables"]["prompts"]["Row"]["purpose"];
export type PromptVariant = Database["public"]["Tables"]["prompt_variants"]["Row"];
export type PromptProposal = Database["public"]["Tables"]["prompt_change_proposals"]["Row"];

export type PromptWithChampion = {
  id: string;
  purpose: PromptPurpose;
  language: "en" | "es";
  description: string | null;
  is_active: boolean;
  updated_at: string;
  champion: PromptVariant | null;
  pending_proposals: number;
};

export type PromptDetail = {
  id: string;
  purpose: PromptPurpose;
  language: "en" | "es";
  description: string | null;
  is_active: boolean;
  variants: PromptVariant[];
  champion: PromptVariant | null;
  proposals: (PromptProposal & {
    current_variant: PromptVariant | null;
    proposed_variant: PromptVariant | null;
  })[];
};

// Human-readable labels for each purpose
export const PURPOSE_LABELS: Record<PromptPurpose, string> = {
  research:              "Research",
  scoring:               "Scoring",
  pain_classification:   "Pain Classification",
  contact_selection:     "Contact Selection",
  pitch_en:              "Pitch (EN)",
  pitch_es:              "Pitch (ES)",
  reply_classify:        "Reply Classification",
  reply_auto_draft:      "Reply Draft",
  learning_proposal:     "Learning Analysis",
  compliance_footer_ca:  "Footer (CASL / CA)",
  compliance_footer_mx:  "Footer (LFPDPPP / MX)",
};

// Group purposes into sidebar sections
export const PURPOSE_GROUPS: { label: string; purposes: PromptPurpose[] }[] = [
  { label: "Pipeline",    purposes: ["pitch_en", "pitch_es", "scoring", "pain_classification", "contact_selection"] },
  { label: "Research",    purposes: ["research"] },
  { label: "Replies",     purposes: ["reply_classify", "reply_auto_draft"] },
  { label: "Learning",    purposes: ["learning_proposal"] },
  { label: "Compliance",  purposes: ["compliance_footer_ca", "compliance_footer_mx"] },
];
