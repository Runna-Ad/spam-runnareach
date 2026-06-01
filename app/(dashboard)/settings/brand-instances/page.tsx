import { Layers } from "lucide-react";

export default function SettingsBrandInstancesPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">
          Brand instances
        </h2>
        <p className="mt-0.5 text-xs text-[var(--color-fg-500)]">
          White-label S.P.A.M for other companies — separate branding, sender, ICP, and prompts per brand.
        </p>
      </div>

      <div className="flex flex-col items-center gap-4 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-800)] px-8 py-12 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-bg-700)]">
          <Layers className="h-5 w-5 text-[var(--color-accent-300)]" aria-hidden />
        </div>
        <div>
          <p className="text-sm font-medium text-[var(--color-fg-50)]">Coming soon</p>
          <p className="mt-1 max-w-sm text-xs text-[var(--color-fg-500)]">
            Run S.P.A.M under a different brand — separate logo, sending domain, compliance footer,
            ICP, and prompt set per instance. Planned for a future release.
          </p>
        </div>
      </div>
    </div>
  );
}
