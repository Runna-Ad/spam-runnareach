import { BenchmarksList } from "@/components/benchmarks/benchmarks-list";
import { ProposalReview } from "@/components/benchmarks/proposal-review";
import { WantedFacts } from "@/components/benchmarks/wanted-facts";
import { requireUser } from "@/lib/auth";
import {
  leaveOutReviewQueue,
  listBenchmarkProposals,
  listPainOptions,
  listRejectedBenchmarks,
  listWantedFacts,
} from "@/lib/benchmarks/proposals";
import { listAllBenchmarks } from "@/lib/benchmarks/queries";

export const dynamic = "force-dynamic";

export default async function BenchmarksPage() {
  const user = await requireUser();
  const [all, proposals, rejected, wanted, pains] = await Promise.all([
    listAllBenchmarks(user.tenantId),
    listBenchmarkProposals(user.tenantId),
    listRejectedBenchmarks(user.tenantId),
    listWantedFacts(user.tenantId),
    listPainOptions(user.tenantId),
  ]);
  const benchmarks = leaveOutReviewQueue(all, proposals, rejected);
  const canEdit = user.role !== "viewer";

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
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

      {proposals.length > 0 || rejected.length > 0 ? (
        <ProposalReview proposals={proposals} rejected={rejected} canEdit={canEdit} />
      ) : null}

      <BenchmarksList benchmarks={benchmarks} />

      <WantedFacts facts={wanted} pains={pains} canEdit={canEdit} />
    </div>
  );
}
