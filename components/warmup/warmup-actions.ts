"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { updateWarmupConfigDay, getWarmupConfig } from "@/lib/warmup/queries";

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

// ── Manual engine trigger ─────────────────────────────────────────────────────

export async function triggerEngineManually(): Promise<
  { ok: true; sent: number } | { ok: false; error: string }
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
      results?: Array<{ sent: number }>;
    };

    const totalSent = json.results?.reduce((sum, r) => sum + (r.sent ?? 0), 0) ?? 0;
    revalidatePath("/warmup");
    return { ok: true, sent: totalSent };
  } catch (err) {
    return { ok: false, error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
