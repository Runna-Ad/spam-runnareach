// ─────────────────────────────────────────────────────────────────────────────
// app/api/warmup/reactivation/route.ts
// Daily auto-reactivation ("re-warm") loop. Runs BEFORE the warmup engine so the
// engine picks up any target change the same day.
//
// Per active config, once per calendar day:
//   1. Gather deliverability signals (derived health score, inbox rate, blocklist,
//      Postmaster reputation).
//   2. Decide (pure lib/warmup/reactivation): enter re-warm on a dip, advance /
//      recover / abort an ongoing re-warm, or hold.
//   3. Apply to warmup_config, write an audit row, and email Pedro on the
//      state-changing transitions (enter / recover / abort).
//
// Auth: CRON_SECRET bearer (Vercel sends it for cron routes).
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import {
  getAllActiveConfigs,
  getRecentLogByConfig,
  getLatestDomainHealth,
  updateWarmupConfigDay,
} from "@/lib/warmup/queries";
import { analyzeSpamRate } from "@/lib/warmup/intelligence";
import { checkDeliverabilityHealth } from "@/lib/warmup/deliverability";
import { getDmarcSummary } from "@/lib/warmup/dmarc-summary";
import { scoreDomainHealth } from "@/lib/warmup/health-score";
import {
  evaluateHealth,
  planReactivation,
  type HealthSignals,
  type ReactivationPlan,
} from "@/lib/warmup/reactivation";
import { resolveDailyTarget } from "@/lib/warmup/types";
import type { WarmupConfig } from "@/lib/warmup/types";

export const maxDuration = 60;

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

type ConfigResult = {
  sending_email: string;
  plan: ReactivationPlan["kind"];
  reason: string;
};

// ── Notification ────────────────────────────────────────────────────────────────

async function notify(config: WarmupConfig, subject: string, body: string): Promise<void> {
  try {
    const supabase = createServiceRoleClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from("sender_inboxes")
      .select("email, display_name, gmail_refresh_token_encrypted")
      .eq("tenant_id", config.tenant_id)
      .eq("email", config.sending_email)
      .maybeSingle();
    if (!data?.gmail_refresh_token_encrypted) return;
    const tok = await getAccessToken(data.gmail_refresh_token_encrypted);
    if (!tok.ok) return;

    const to =
      process.env.WARMUP_NOTIFY_EMAIL ||
      process.env.REPLY_FUNNEL_NOTIFY_EMAIL ||
      "petedv31@gmail.com";
    await sendGmailMessage({
      accessToken: tok.accessToken,
      fromEmail: data.email,
      fromName: "S.P.A.M Warmup",
      to,
      subject,
      body,
    });
  } catch (err) {
    console.warn("[warmup/reactivation] notify failed:", err);
  }
}

async function writeAudit(
  config: WarmupConfig,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    const supabase = createServiceRoleClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("audit_log").insert({
      tenant_id: config.tenant_id,
      actor_id: null,
      action,
      entity_type: "warmup",
      entity_id: config.id,
      metadata,
    });
  } catch (err) {
    console.warn("[warmup/reactivation] audit write failed:", err);
  }
}

// ── Per-config evaluation ─────────────────────────────────────────────────────

async function processConfig(config: WarmupConfig): Promise<ConfigResult> {
  const supabase = createServiceRoleClient();
  const domain = config.sending_email.split("@")[1] ?? "";
  const today = new Date().toISOString().split("T")[0] as string;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://spam-runnareach.vercel.app";

  // ── 1. Gather signals (all best-effort — a DNS/DMARC hiccup must not crash) ──
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [deliverability, dmarc, recentLogs, postmaster] = await Promise.all([
    domain ? checkDeliverabilityHealth(domain).catch(() => null) : Promise.resolve(null),
    domain
      ? getDmarcSummary(supabase, config.tenant_id, domain, 14).catch(() => null)
      : Promise.resolve(null),
    getRecentLogByConfig(config.id, sevenDaysAgo).catch(() => []),
    domain ? getLatestDomainHealth(config.tenant_id, domain).catch(() => null) : Promise.resolve(null),
  ]);

  const spam = analyzeSpamRate(recentLogs);
  const signals: HealthSignals = {
    healthScore: scoreDomainHealth(dmarc, deliverability),
    inboxRate: spam.inboxRate,
    blocklistListed: deliverability?.blocklist.status === "fail",
    postmasterRep: postmaster?.domain_reputation ?? null,
  };
  const verdict = evaluateHealth(signals);

  // ── 2. Decide ────────────────────────────────────────────────────────────────
  const plan = planReactivation({
    status: config.status,
    rewarmStartedAt: config.rewarm_started_at,
    rewarmDay: config.rewarm_day,
    healthyStreak: config.healthy_streak,
    lastHealthEvalDate: config.last_health_eval_date,
    today,
    verdict,
  });

  const metaBase = {
    signals,
    health_score: signals.healthScore,
    inbox_rate: signals.inboxRate,
    reasons: verdict.reasons,
  };

  // ── 3. Apply ───────────────────────────────────────────────────────────────────
  switch (plan.kind) {
    case "enter": {
      await updateWarmupConfigDay(config.id, {
        rewarm_started_at: new Date().toISOString(),
        rewarm_day: plan.rewarmDay,
        rewarm_reason: plan.reason,
        healthy_streak: 0,
        last_health_eval_date: today,
        daily_target: plan.target,
      });
      await writeAudit(config, "warmup.rewarm_entered", { ...metaBase, target: plan.target });
      await notify(
        config,
        `⚠️ Re-warm started for ${domain} (${plan.target}/day)`,
        `Deliverability dipped, so warmup automatically re-entered a gentle re-warm ramp.\n\n` +
          `Why: ${plan.reason}\n` +
          `Starting volume: ${plan.target}/day, climbing to full over ~2 weeks, then back to maintenance once inbox placement recovers.\n\n` +
          `Dashboard: ${appUrl}/warmup`,
      );
      break;
    }
    case "advance": {
      await updateWarmupConfigDay(config.id, {
        rewarm_day: plan.rewarmDay,
        healthy_streak: plan.healthyStreak,
        last_health_eval_date: today,
        daily_target: plan.target,
      });
      await writeAudit(config, "warmup.rewarm_advanced", {
        ...metaBase,
        rewarm_day: plan.rewarmDay,
        healthy_streak: plan.healthyStreak,
        target: plan.target,
      });
      break;
    }
    case "recover": {
      await updateWarmupConfigDay(config.id, {
        rewarm_started_at: null,
        rewarm_day: 0,
        rewarm_reason: null,
        healthy_streak: 0,
        last_health_eval_date: today,
        daily_target: resolveDailyTarget({ ...config, rewarm_started_at: null, rewarm_day: 0 }),
      });
      await writeAudit(config, "warmup.rewarm_recovered", metaBase);
      await notify(
        config,
        `✅ ${domain} recovered — back to maintenance`,
        `Deliverability held healthy through the re-warm, so warmup settled back to the maintenance schedule.\n\n` +
          `Dashboard: ${appUrl}/warmup`,
      );
      break;
    }
    case "abort": {
      await updateWarmupConfigDay(config.id, {
        rewarm_started_at: null,
        rewarm_day: 0,
        rewarm_reason: null,
        healthy_streak: 0,
        last_health_eval_date: today,
        daily_target: resolveDailyTarget({ ...config, rewarm_started_at: null, rewarm_day: 0 }),
      });
      await writeAudit(config, "warmup.rewarm_aborted", metaBase);
      await notify(
        config,
        `🛑 Re-warm gave up on ${domain} — needs a look`,
        `The re-warm ran its full duration without a sustained recovery and has dropped back to maintenance.\n\n` +
          `This usually means the problem isn't volume — check authentication (SPF/DKIM/DMARC), ` +
          `whether the domain is genuinely blocklisted, and the DMARC report senders.\n\n` +
          `Latest reasons: ${verdict.reasons.join("; ") || "none recorded"}\n` +
          `Dashboard: ${appUrl}/warmup`,
      );
      break;
    }
    case "none": {
      // Healthy at maintenance — record that we looked so we don't re-evaluate today.
      await updateWarmupConfigDay(config.id, { last_health_eval_date: today });
      break;
    }
    case "hold":
    case "skip":
      // No write — hold (already ran today) / skip (paused).
      break;
  }

  return { sending_email: config.sending_email, plan: plan.kind, reason: plan.reason };
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const results: ConfigResult[] = [];

  try {
    await Sentry.withMonitor(
      "warmup-reactivation",
      async () => {
        const configs = await getAllActiveConfigs();
        for (const config of configs) {
          try {
            results.push(await processConfig(config));
          } catch (err) {
            console.error(`[warmup/reactivation] config ${config.id} failed:`, err);
            results.push({
              sending_email: config.sending_email,
              plan: "skip",
              reason: `error: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      },
      {
        schedule: { type: "crontab", value: "30 13 * * *" },
        checkinMargin: 30,
        maxRuntime: 3,
        timezone: "UTC",
        failureIssueThreshold: 2,
        recoveryThreshold: 1,
      },
    );
  } catch (err) {
    console.error("[warmup/reactivation] Fatal error:", err);
    return NextResponse.json({ error: "Reactivation error", details: String(err) }, { status: 500 });
  }

  return NextResponse.json({ ok: true, duration_ms: Date.now() - startTime, results });
}
