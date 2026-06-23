import { WarmupDashboard } from "@/components/warmup/warmup-dashboard";
import { requireUser } from "@/lib/auth";
import {
  getWarmupConfig,
  getRecentLog,
  getDomainHealthHistory,
  getLatestDomainHealth,
  getTotalSentCount,
} from "@/lib/warmup/queries";
import { checkDeliverabilityHealth } from "@/lib/warmup/deliverability";
import { getDmarcSummary } from "@/lib/warmup/dmarc-summary";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";

export default async function WarmupPage() {
  const user = await requireUser();

  const config = await getWarmupConfig(user.tenantId);
  const domain = config?.sending_email.split("@")[1] ?? "";

  const [recentLog, healthHistory, latestHealth, totalSent, deliverability, dmarc] = await Promise.all([
    config ? getRecentLog(user.tenantId, 50) : Promise.resolve([]),
    config ? getDomainHealthHistory(user.tenantId, domain, 14) : Promise.resolve([]),
    config ? getLatestDomainHealth(user.tenantId, domain) : Promise.resolve(null),
    config ? getTotalSentCount(user.tenantId) : Promise.resolve(0),
    // Low-volume deliverability signals (DNS auth + blocklist) — work from email
    // #1, unlike Postmaster. Best-effort: never block the page on DNS.
    domain ? checkDeliverabilityHealth(domain).catch(() => null) : Promise.resolve(null),
    // In-house DMARC aggregate-report summary (already-ingested reports). Pass
    // rate + unauthorized sources. Best-effort: never block the page.
    domain
      ? getDmarcSummary(createServiceRoleClient(), user.tenantId, domain, 14).catch(() => null)
      : Promise.resolve(null),
  ]);

  return (
    <WarmupDashboard
      config={config}
      recentLog={recentLog}
      healthHistory={healthHistory}
      latestHealth={latestHealth}
      totalSent={totalSent}
      deliverability={deliverability}
      dmarc={dmarc}
    />
  );
}
