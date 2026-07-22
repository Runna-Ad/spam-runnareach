import { BenchmarksList } from "@/components/benchmarks/benchmarks-list";
import { requireUser } from "@/lib/auth";
import { listAllBenchmarks } from "@/lib/benchmarks/queries";

export const dynamic = "force-dynamic";

export default async function BenchmarksPage() {
  const user = await requireUser();
  const benchmarks = await listAllBenchmarks(user.tenantId);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight text-[var(--color-fg-50)]">
          Benchmarks
        </h1>
        <p className="mt-1 text-sm text-[var(--color-fg-500)]">
          The only numbers a pitch may cite. Every row carries a real source, but a citation is not
          the same as being applicable — read the caveat before activating, because you&apos;re the
          one who defends the figure if a prospect asks where it came from.
        </p>
      </div>

      <BenchmarksList benchmarks={benchmarks} />
    </div>
  );
}
