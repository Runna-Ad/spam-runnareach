/**
 * Teaching the Inefficiency Hunter which findings work.
 *
 * Two kinds of evidence, both per Hunter industry × finding id:
 *   - the Hunter's own: a finding shown to a visitor who then asked to talk
 *     (hunter_scans.results.findings[].id + contacted) is a success;
 *   - S.P.A.M.'s: a pitch whose audit link pinned that finding (painToLeadKey)
 *     and earned a reply or a scan, scored by the shared outcome value.
 *
 * The weight is the posterior mean of a Beta(1, 1) over both, so an unseen
 * finding sits at 0.5 and only evidence moves it. Only findings with evidence
 * are returned; the Hunter treats a missing weight as "no opinion".
 *
 * Pure — tested in tests/hunter-weights.test.ts.
 */

export type ScanEvidence = { industry: string | null; findingIds: readonly string[]; contacted: boolean };
export type PitchEvidence = { industry: string; lead: string | null; value: number | null };

export type FindingWeights = Record<string, Record<string, number>>;

export function findingWeights(scans: readonly ScanEvidence[], pitches: readonly PitchEvidence[]): FindingWeights {
  const tally = new Map<string, { s: number; n: number }>();
  const add = (industry: string, id: string, success: number) => {
    const key = `${industry}\u0000${id}`;
    const t = tally.get(key) ?? { s: 0, n: 0 };
    t.s += success;
    t.n += 1;
    tally.set(key, t);
  };
  for (const scan of scans) {
    const industry = scan.industry ?? "other";
    for (const id of scan.findingIds) add(industry, id, scan.contacted ? 1 : 0);
  }
  for (const p of pitches) {
    if (!p.lead || p.value === null) continue;
    add(p.industry, p.lead, Math.min(Math.max(p.value, 0), 1));
  }
  const out: FindingWeights = {};
  for (const [key, t] of tally) {
    const [industry, id] = key.split("\u0000") as [string, string];
    (out[industry] ??= {})[id] = Math.round(((1 + t.s) / (2 + t.n)) * 1000) / 1000;
  }
  return out;
}
