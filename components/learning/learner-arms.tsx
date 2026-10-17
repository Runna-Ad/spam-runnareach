import type { ArmConfidence, ArmSummary, LearnerGroup } from "@/lib/learning/report";
import { Chip } from "@/components/ui/chip";

const CONFIDENCE_TONE: Record<ArmConfidence, "neutral" | "warning" | "success"> = {
  "too early": "neutral",
  early: "warning",
  settled: "success",
};

const STATUS_TONE = { champion: "success", challenger: "info", retired: "neutral" } as const;

function ArmTable({ arms }: { arms: ArmSummary[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-white/40">
          <th className="py-1 pr-3 font-medium">Arm</th>
          <th className="py-1 pr-3 font-medium">Status</th>
          <th className="py-1 pr-3 font-medium text-right">Trials</th>
          <th className="py-1 pr-3 font-medium text-right">Reward rate</th>
          <th className="py-1 pr-3 font-medium text-right">Negatives</th>
          <th className="py-1 font-medium">Confidence</th>
        </tr>
      </thead>
      <tbody>
        {arms.map((a) => (
          <tr key={a.key} className="border-t border-white/5 text-white/80">
            <td className="py-1.5 pr-3 font-mono text-xs">{a.key}</td>
            <td className="py-1.5 pr-3">
              <Chip tone={STATUS_TONE[a.status]}>{a.status}</Chip>
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{a.trials}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">
              {a.rate === null ? <span className="text-white/30">hidden</span> : `${(a.rate * 100).toFixed(1)}%`}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{a.negatives}</td>
            <td className="py-1.5">
              <Chip tone={CONFIDENCE_TONE[a.confidence]}>{a.confidence}</Chip>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LearnerArms({ groups }: { groups: LearnerGroup[] }) {
  return (
    <section className="px-6 py-4 border-b border-white/10 shrink-0 max-h-[40vh] overflow-y-auto">
      <h2 className="text-base font-semibold text-white">Learners</h2>
      <p className="text-xs text-white/40 mb-1">
        Observation only: nothing here changes what the system does.
      </p>
      <p className="text-xs text-white/40 mb-3">
        Fewer than 20 trials is too early to read (rate hidden), 20–99 is early, 100+ is settled.
      </p>
      {groups.length === 0 ? (
        <p className="text-sm text-white/30">No learner has recorded an arm yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <div key={g.learner} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-baseline gap-2">
                <h3 className="text-sm font-medium text-white">{g.label}</h3>
                <span className="font-mono text-xs text-white/30">{g.learner}</span>
              </div>
              {g.description && <p className="text-xs text-white/40 mb-2">{g.description}</p>}
              {g.active.length > 0 ? (
                <ArmTable arms={g.active} />
              ) : (
                <p className="text-xs text-white/30">No active arms.</p>
              )}
              {g.retired.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-white/40">
                    Retired arms ({g.retired.length})
                  </summary>
                  <div className="mt-1 opacity-70">
                    <ArmTable arms={g.retired} />
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
