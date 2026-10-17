// Read-only summary of learning_arms for the /learning "Learners" section.
// Pure: no server imports, so client components can use the types.
//
// Confidence rule (Pedro's lesson): a rate is only shown once there is a
// sample to carry it. n < 20 is "too early" and the rate is hidden.

export type ArmStatus = "champion" | "challenger" | "retired";
export type ArmConfidence = "too early" | "early" | "settled";

export interface ArmRow {
  learner: string;
  key: string;
  status: ArmStatus;
  origin: string;
  reward: number;
  trials: number;
  negatives: number;
  updated_at: string;
}

export interface ArmSummary extends ArmRow {
  confidence: ArmConfidence;
  /** reward / trials; null while confidence is "too early" (or trials is 0). */
  rate: number | null;
}

export interface LearnerGroup {
  learner: string;
  label: string;
  description: string;
  active: ArmSummary[];
  retired: ArmSummary[];
}

export const EARLY_MIN_TRIALS = 20;
export const SETTLED_MIN_TRIALS = 100;

const LEARNER_INFO: Record<string, { label: string; description: string }> = {
  "writer.evidence": {
    label: "Writer: evidence",
    description: "Whether a pitch may cite one sourced benchmark or only the prospect's own evidence.",
  },
  "writer.guidance": {
    label: "Writer: guidance",
    description: "Extra writing guidance the learner tries on top of the base prompt.",
  },
  "scout.cell": {
    label: "Scout cells",
    description: "Industry × city cells the discovery scout searches; reward is what those prospects go on to yield.",
  },
  icp: {
    label: "ICP terms",
    description: "Search terms and traits that describe the ideal customer profile.",
  },
};

export function confidenceFor(trials: number): ArmConfidence {
  if (trials < EARLY_MIN_TRIALS) return "too early";
  if (trials < SETTLED_MIN_TRIALS) return "early";
  return "settled";
}

const STATUS_ORDER: Record<ArmStatus, number> = { champion: 0, challenger: 1, retired: 2 };

function summarize(row: ArmRow): ArmSummary {
  const confidence = confidenceFor(row.trials);
  const rate = confidence === "too early" || row.trials <= 0 ? null : row.reward / row.trials;
  return { ...row, confidence, rate };
}

function compareArms(a: ArmSummary, b: ArmSummary): number {
  return (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    b.trials - a.trials ||
    a.key.localeCompare(b.key)
  );
}

/** Group arms by learner (known learners first, then the rest A-Z); champion first, retired apart. */
export function summarizeArms(rows: ArmRow[]): LearnerGroup[] {
  const byLearner = new Map<string, ArmSummary[]>();
  for (const row of rows) {
    const list = byLearner.get(row.learner) ?? [];
    list.push(summarize(row));
    byLearner.set(row.learner, list);
  }
  const known = Object.keys(LEARNER_INFO);
  const order = (l: string) => {
    const i = known.indexOf(l);
    return i === -1 ? known.length : i;
  };
  return [...byLearner.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([learner, arms]) => {
      const sorted = [...arms].sort(compareArms);
      const info = LEARNER_INFO[learner];
      return {
        learner,
        label: info?.label ?? learner,
        description: info?.description ?? "",
        active: sorted.filter((a) => a.status !== "retired"),
        retired: sorted.filter((a) => a.status === "retired"),
      };
    });
}
