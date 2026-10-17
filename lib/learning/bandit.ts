/**
 * Choosing between options while learning which is best (Thompson sampling).
 *
 * Every learner has "arms": the writer's angles or subject styles, the scout's
 * search cells, the scheduler's send windows. Each arm keeps a Beta posterior
 * over its reward (0..1, from lib/learning/reward.ts). To choose, draw one
 * sample per arm and take the highest: arms that work get most of the traffic,
 * uncertain arms still get tried, and nothing waits for "significance".
 *
 * Autonomy rules (`reviewArms`), applied by the learner on a schedule:
 *   - a challenger that is ≥ 95% likely the best, with enough trials, becomes
 *     champion; the old champion stays as a challenger;
 *   - a challenger that is ≤ 5% likely the best, with enough trials, retires;
 *   - an arm whose negative rate (opt-outs, hard no's) runs far above the
 *     baseline retires at once, champion or not, regardless of reward;
 *   - there is always exactly one champion, and the champion keeps a fixed
 *     share of traffic as a control so drift is visible.
 *
 * Pure and seedable — tested in tests/learning.test.ts.
 */

export type ArmStatus = "champion" | "challenger" | "retired";

export type Arm = {
  key: string;
  status: ArmStatus;
  /** Sum of settled rewards (fractional successes). */
  reward: number;
  /** Settled trials. */
  trials: number;
  /** Settled trials that ended in an opt-out or hard no. */
  negatives?: number;
  /** Prior pseudo-counts; defaults to a weak Beta(1, 1). */
  prior?: { alpha: number; beta: number };
};

export type Rng = () => number;

/** Small, fast, seedable PRNG (mulberry32). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: Rng): number {
  // Box–Muller.
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Gamma(shape, 1) by Marsaglia–Tsang. */
export function sampleGamma(shape: number, rng: Rng): number {
  if (shape < 1) return sampleGamma(shape + 1, rng) * Math.pow(rng() || Number.MIN_VALUE, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number, rng: Rng): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y);
}

function posterior(arm: Arm): { alpha: number; beta: number } {
  const p = arm.prior ?? { alpha: 1, beta: 1 };
  const reward = Math.min(Math.max(arm.reward, 0), arm.trials);
  return { alpha: p.alpha + reward, beta: p.beta + (arm.trials - reward) };
}

/** Posterior mean reward (for dashboards; choosing uses samples). */
export function meanReward(arm: Arm): number {
  const { alpha, beta } = posterior(arm);
  return alpha / (alpha + beta);
}

const active = (arms: readonly Arm[]) => arms.filter((a) => a.status !== "retired");

/**
 * Pick an arm. `controlShare` of the time the champion is used outright, as a
 * stable control; otherwise Thompson sampling over all active arms.
 */
export function chooseArm(
  arms: readonly Arm[],
  opts: { rng?: Rng; controlShare?: number } = {},
): Arm | null {
  const rng = opts.rng ?? Math.random;
  const pool = active(arms);
  if (pool.length === 0) return null;
  const champion = pool.find((a) => a.status === "champion");
  if (champion && rng() < (opts.controlShare ?? 0.2)) return champion;
  let best: Arm | null = null;
  let bestDraw = -1;
  for (const arm of pool) {
    const { alpha, beta } = posterior(arm);
    const draw = sampleBeta(alpha, beta, rng);
    if (draw > bestDraw) {
      bestDraw = draw;
      best = arm;
    }
  }
  return best;
}

/** Monte Carlo probability that each active arm has the highest true reward. */
export function probabilityBest(arms: readonly Arm[], opts: { rng?: Rng; draws?: number } = {}): Map<string, number> {
  const rng = opts.rng ?? Math.random;
  const draws = opts.draws ?? 4000;
  const pool = active(arms);
  const wins = new Map(pool.map((a) => [a.key, 0]));
  const params = pool.map((a) => ({ key: a.key, ...posterior(a) }));
  for (let i = 0; i < draws; i++) {
    let bestKey = "";
    let bestDraw = -1;
    for (const p of params) {
      const d = sampleBeta(p.alpha, p.beta, rng);
      if (d > bestDraw) {
        bestDraw = d;
        bestKey = p.key;
      }
    }
    wins.set(bestKey, (wins.get(bestKey) ?? 0) + 1);
  }
  return new Map([...wins].map(([k, w]) => [k, w / draws]));
}

export type ArmAction =
  | { kind: "promote"; key: string; pBest: number; demoted: string | null }
  | { kind: "retire"; key: string; reason: "losing" | "negatives"; pBest?: number; negativeRate?: number };

export type ReviewOptions = {
  rng?: Rng;
  minTrials?: number;
  promoteAt?: number;
  retireAt?: number;
  /** Negative (opt-out / hard no) rate across all arms, the baseline. */
  baselineNegativeRate?: number;
};

/**
 * Promotion / retirement decisions for one learner's arms. Returns the actions
 * and the arms after applying them; the caller persists both and logs each
 * action as an insight so every autonomous change is explainable.
 */
export function reviewArms(arms: readonly Arm[], opts: ReviewOptions = {}): { actions: ArmAction[]; arms: Arm[] } {
  const minTrials = opts.minTrials ?? 30;
  const promoteAt = opts.promoteAt ?? 0.95;
  const retireAt = opts.retireAt ?? 0.05;
  const actions: ArmAction[] = [];
  let next = arms.map((a) => ({ ...a }));

  // 1. Guardrail: an arm that drives opt-outs retires regardless of reward.
  const base = opts.baselineNegativeRate ?? 0;
  for (const arm of active(next)) {
    const negatives = arm.negatives ?? 0;
    if (arm.trials < 20) continue;
    const rate = negatives / arm.trials;
    if (rate > Math.max(2 * base, 0.05)) {
      actions.push({ kind: "retire", key: arm.key, reason: "negatives", negativeRate: rate });
      arm.status = "retired";
    }
  }
  // Never leave the learner without a champion: the best remaining arm takes over.
  if (!next.some((a) => a.status === "champion")) {
    const candidates = active(next).sort((a, b) => meanReward(b) - meanReward(a));
    if (candidates[0]) {
      candidates[0].status = "champion";
      actions.push({ kind: "promote", key: candidates[0].key, pBest: NaN, demoted: null });
    }
  }

  // 2. Promotion and retirement on reward.
  const pool = active(next);
  if (pool.length >= 2) {
    const pBest = probabilityBest(pool, { rng: opts.rng });
    const champion = pool.find((a) => a.status === "champion") ?? null;
    const leader = pool
      .filter((a) => a.status === "challenger" && a.trials >= minTrials)
      .sort((a, b) => (pBest.get(b.key) ?? 0) - (pBest.get(a.key) ?? 0))[0];
    let demoted: string | null = null;
    if (leader && (pBest.get(leader.key) ?? 0) >= promoteAt) {
      if (champion) champion.status = "challenger";
      leader.status = "champion";
      demoted = champion?.key ?? null;
      actions.push({ kind: "promote", key: leader.key, pBest: pBest.get(leader.key) ?? 0, demoted });
    }
    for (const arm of pool) {
      // A just-demoted champion stays one more round as the comparison.
      if (arm.status !== "challenger" || arm.trials < minTrials || arm.key === demoted) continue;
      const p = pBest.get(arm.key) ?? 0;
      if (p <= retireAt) {
        arm.status = "retired";
        actions.push({ kind: "retire", key: arm.key, reason: "losing", pBest: p });
      }
    }
  }

  next = next.map((a) => ({ ...a }));
  return { actions, arms: next };
}
