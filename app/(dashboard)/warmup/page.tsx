import { WarmupDashboard } from "@/components/warmup/warmup-dashboard";
import { requireUser } from "@/lib/auth";
import {
  getWarmupConfig,
  getRecentLog,
  getDomainHealthHistory,
  getLatestDomainHealth,
  getTotalSentCount,
} from "@/lib/warmup/queries";

export const dynamic = "force-dynamic";

export default async function WarmupPage() {
  const user = await requireUser();

  const config = await getWarmupConfig(user.tenantId);

  const [recentLog, healthHistory, latestHealth, totalSent] = await Promise.all([
    config ? getRecentLog(user.tenantId, 50) : Promise.resolve([]),
    config
      ? getDomainHealthHistory(
          user.tenantId,
          config.sending_email.split("@")[1] ?? "",
          14,
        )
      : Promise.resolve([]),
    config
      ? getLatestDomainHealth(
          user.tenantId,
          config.sending_email.split("@")[1] ?? "",
        )
      : Promise.resolve(null),
    config ? getTotalSentCount(user.tenantId) : Promise.resolve(0),
  ]);

  return (
    <WarmupDashboard
      config={config}
      recentLog={recentLog}
      healthHistory={healthHistory}
      latestHealth={latestHealth}
      totalSent={totalSent}
    />
  );
}
