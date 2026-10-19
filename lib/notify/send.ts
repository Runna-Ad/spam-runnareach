/**
 * Send a notification email to the notify list (lib/notify/recipients.ts) from a
 * connected inbox. Every platform alert, digest and report goes through here:
 * do not read a *_NOTIFY_EMAIL variable or hard-code an address anywhere else.
 *
 * One message per recipient (the MIME builder takes a single To address). Never
 * throws: a notification is evidence, not a dependency of the job that sends it.
 */

import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import { notifyRecipients, type NotifyKind } from "./recipients.ts";

export type NotificationResult = { sent: number; failed: string[] };

const NOTIFY_SEND_TIMEOUT_MS = 15_000;

export type NotificationMessage = {
  kind: NotifyKind;
  subject: string;
  body: string;
  /** Optional designed HTML part; `body` stays the plain-text part (lib/gmail/mime.ts). */
  html?: string;
  fromName: string;
};

/** When the caller already holds an access token for a connected inbox. */
export async function sendNotificationWithToken(
  sender: { accessToken: string; fromEmail: string },
  message: NotificationMessage,
): Promise<NotificationResult> {
  const result: NotificationResult = { sent: 0, failed: [] };
  for (const to of notifyRecipients(message.kind)) {
    try {
      const res = await sendGmailMessage({
        accessToken: sender.accessToken,
        fromEmail: sender.fromEmail,
        fromName: message.fromName,
        to,
        subject: message.subject,
        body: message.body,
        html: message.html,
        // Alerts often run at the end of a route near its maxDuration.
        timeoutMs: NOTIFY_SEND_TIMEOUT_MS,
      });
      if (res.ok) result.sent++;
      else result.failed.push(`${to}: ${res.error}`);
    } catch (err) {
      result.failed.push(`${to}: ${(err as Error).message}`);
    }
  }
  if (result.failed.length > 0) console.warn("[notify] some recipients failed:", result.failed.join(" | "));
  return result;
}

/**
 * Finds the sender: `fromEmail` when given and connected, else the tenant's
 * connected inboxes oldest first (the oldest is the one the calendar sync
 * reads), moving to the next when one's token fails. When no inbox can send,
 * the alert goes to Sentry instead: an emergency about a disconnected Google
 * account must not be lost because it would be sent through that account.
 */
export async function sendNotification(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  tenantId: string,
  message: NotificationMessage & { fromEmail?: string },
): Promise<NotificationResult> {
  const failed: string[] = [];
  try {
    let q = db
      .from("sender_inboxes")
      .select("email, gmail_refresh_token_encrypted")
      .eq("tenant_id", tenantId)
      .not("gmail_refresh_token_encrypted", "is", null);
    if (message.fromEmail) q = q.eq("email", message.fromEmail);
    const { data } = await q.order("created_at", { ascending: true }).limit(5);
    const inboxes = (data ?? []) as Array<{ email: string; gmail_refresh_token_encrypted: string }>;
    if (inboxes.length === 0) failed.push("no connected inbox");
    for (const inbox of inboxes) {
      const token = await getAccessToken(inbox.gmail_refresh_token_encrypted);
      if (!token.ok) {
        failed.push(`${inbox.email} token: ${token.error}`);
        continue;
      }
      const result = await sendNotificationWithToken({ accessToken: token.accessToken, fromEmail: inbox.email }, message);
      if (result.sent > 0) return { sent: result.sent, failed: [...failed, ...result.failed] };
      failed.push(...result.failed);
    }
  } catch (err) {
    failed.push((err as Error).message);
  }
  console.warn("[notify] not sent:", message.subject, failed.join(" | "));
  Sentry.captureMessage(`Notification not sent: ${message.subject}`, {
    level: "error",
    extra: { kind: message.kind, body: message.body.slice(0, 2000), failed },
  });
  return { sent: 0, failed };
}
