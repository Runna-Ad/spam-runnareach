"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { updateWarmupConfigDay, getWarmupConfig } from "@/lib/warmup/queries";
import { rewarmTargetForDay, getDailyTarget } from "@/lib/warmup/types";

// ── Pause warmup ──────────────────────────────────────────────────────────────

export async function pauseWarmup(
  configId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot modify warmup." };

  // Verify the config belongs to this tenant
  const config = await getWarmupConfig(user.tenantId);
  if (!config || config.id !== configId) {
    return { ok: false, error: "Config not found." };
  }

  await updateWarmupConfigDay(configId, {
    status: "paused",
    pause_reason: "Manually paused by user",
  });

  revalidatePath("/warmup");
  return { ok: true };
}

// ── Resume warmup ─────────────────────────────────────────────────────────────

export async function resumeWarmup(
  configId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot modify warmup." };

  const config = await getWarmupConfig(user.tenantId);
  if (!config || config.id !== configId) {
    return { ok: false, error: "Config not found." };
  }

  await updateWarmupConfigDay(configId, {
    status: "active",
    pause_reason: null,
  });

  revalidatePath("/warmup");
  return { ok: true };
}

// ── Manual re-warm (start / stop) ─────────────────────────────────────────────
// Pedro's "warm up again" button. Pulls the domain off the maintenance floor and
// into the same gentle re-warm ramp the auto-reactivation loop uses. The daily
// loop then advances / recovers it from here.

export async function rewarmNow(
  configId: string,
): Promise<{ ok: true; target: number } | { ok: false; error: string }> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot modify warmup." };

  const config = await getWarmupConfig(user.tenantId);
  if (!config || config.id !== configId) return { ok: false, error: "Config not found." };

  const today = new Date().toISOString().split("T")[0] as string;
  const target = rewarmTargetForDay(1);
  await updateWarmupConfigDay(configId, {
    status: "active",
    pause_reason: null,
    rewarm_started_at: new Date().toISOString(),
    rewarm_day: 1,
    rewarm_reason: "manual re-warm",
    healthy_streak: 0,
    // Mark today evaluated so the auto-loop holds today and advances from tomorrow
    // (avoids double-counting day 1).
    last_health_eval_date: today,
    daily_target: target,
  });

  revalidatePath("/warmup");
  return { ok: true, target };
}

export async function stopRewarm(
  configId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot modify warmup." };

  const config = await getWarmupConfig(user.tenantId);
  if (!config || config.id !== configId) return { ok: false, error: "Config not found." };

  const today = new Date().toISOString().split("T")[0] as string;
  await updateWarmupConfigDay(configId, {
    rewarm_started_at: null,
    rewarm_day: 0,
    rewarm_reason: null,
    healthy_streak: 0,
    // Keep today marked so it doesn't immediately auto-re-enter on the same signals.
    last_health_eval_date: today,
    daily_target: getDailyTarget(config.current_day),
  });

  revalidatePath("/warmup");
  return { ok: true };
}

// ── Manual engine trigger ─────────────────────────────────────────────────────

export async function triggerEngineManually(): Promise<
  { ok: true; sent: number; reasons: string[] } | { ok: false; error: string }
> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot trigger engine." };

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return { ok: false, error: "CRON_SECRET not set." };

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000");

  try {
    const res = await fetch(`${baseUrl}/api/warmup/engine`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cronSecret}` },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Engine returned ${res.status}: ${body.slice(0, 200)}` };
    }

    const json = (await res.json()) as {
      ok: boolean;
      results?: Array<{ sent: number; sending_email?: string; skipped_reason?: string }>;
    };

    const totalSent = json.results?.reduce((sum, r) => sum + (r.sent ?? 0), 0) ?? 0;
    // Surface per-config skip reasons so a "sent 0" result is never a silent mystery.
    const reasons =
      json.results
        ?.filter((r) => r.sent === 0 && r.skipped_reason)
        .map((r) => `${r.sending_email ?? "config"}: ${r.skipped_reason}`) ?? [];
    revalidatePath("/warmup");
    return { ok: true, sent: totalSent, reasons };
  } catch (err) {
    return { ok: false, error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
