import "server-only";

/**
 * Is this request one of our schedulers?
 *
 *   isCronAuthorized      Vercel cron (daily tier) and the app's own worker
 *                         chain: `Authorization: Bearer <CRON_SECRET>`.
 *   isSchedulerAuthorized also accepts Supabase pg_cron (the autopilot's
 *                         frequent schedule, migration 0041). Its token is
 *                         generated inside the database and kept in Supabase
 *                         Vault; the app never holds it, it asks Postgres
 *                         (scheduler_token_valid, service role only) whether
 *                         the presented token matches.
 *
 * Constant-time comparison for the env secret; a missing secret never matches.
 */

import { timingSafeEqual } from "node:crypto";
import { createServiceRoleClient } from "./supabase/service-role";

export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function isSchedulerAuthorized(req: Request): Promise<boolean> {
  if (isCronAuthorized(req)) return true;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token.length < 32 || token.length > 200) return false;
  try {
    // scheduler_token_valid (0041) isn't in the generated types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (createServiceRoleClient() as any).rpc("scheduler_token_valid", { token });
    return !error && data === true;
  } catch {
    return false;
  }
}
