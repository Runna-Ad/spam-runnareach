"use client";

/**
 * Simple line-level diff between two text blocks.
 * No external library — renders added/removed/unchanged lines with colour.
 */

interface Props {
  label: string;
  before: string;
  after: string;
}

type DiffLine =
  | { type: "unchanged"; text: string }
  | { type: "removed"; text: string }
  | { type: "added"; text: string };

function diffLines(a: string, b: string): DiffLine[] {
  const aLines = a.split("\n");
  const bLines = b.split("\n");

  // Build LCS length table
  const m = aLines.length;
  const n = bLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (aLines[i - 1] === bLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      result.unshift({ type: "unchanged", text: aLines[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.unshift({ type: "added", text: bLines[j - 1]! });
      j--;
    } else {
      result.unshift({ type: "removed", text: aLines[i - 1]! });
      i--;
    }
  }

  return result;
}

export function VariantDiff({ label, before, after }: Props) {
  const lines = diffLines(before, after);
  const hasChanges = lines.some((l) => l.type !== "unchanged");

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold text-white/50 uppercase tracking-wide">{label}</p>
      {!hasChanges ? (
        <p className="text-xs text-white/30 italic px-3">No changes in this section.</p>
      ) : (
        <div className="rounded-lg border border-white/10 overflow-hidden font-mono text-xs leading-relaxed">
          {lines.map((line, idx) => (
            <div
              key={idx}
              className={
                line.type === "added"
                  ? "bg-emerald-500/10 text-emerald-300 px-3 py-0.5"
                  : line.type === "removed"
                    ? "bg-red-500/10 text-red-300 px-3 py-0.5 line-through opacity-60"
                    : "text-white/40 px-3 py-0.5"
              }
            >
              <span className="select-none mr-2 opacity-40">
                {line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}
              </span>
              {line.text || " "}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
