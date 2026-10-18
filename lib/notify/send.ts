/**
 * Send a notification email to the notify list (lib/notify/recipients.ts) from a
 * connected inbox. Every platform alert, digest and report goes through here:
 * do not read a *_NOTIFY_EMAIL variable or hard-code an address anywhere else.
 *
 * One message per recipient (the MIME builder takes a single To address). Never
 * throws: a notification is evidence, not a dependency of the job that sends it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import { notifyRecipients, type NotifyKind } from "./recipients.ts";

export type NotificationResult = { sent: number; failed: string[] };

export type NotificationMessage = {
  kind: NotifyKind;
  subject: string;
  body: string;
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
 * Finds the sender: `fromEmail` when given and connected, else the tenant's oldest
 * connected inbox (the same one the calendar sync reads).
 */
export async function sendNotification(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  tenantId: string,
  message: NotificationMessage & { fromEmail?: string },
): Promise<NotificationResult> {
  try {
    let q = db
      .from("sender_inboxes")
      .select("email, gmail_refresh_token_encrypted")
      .eq("tenant_id", tenantId)
      .not("gmail_refresh_token_encrypted", "is", null);
    if (message.fromEmail) q = q.eq("email", message.fromEmail);
    const { data } = await q.order("created_at", { ascending: true }).limit(1);
    const inbox = (data ?? [])[0] as { email: string; gmail_refresh_token_encrypted: string } | undefined;
    if (!inbox) return { sent: 0, failed: ["no connected inbox"] };
    const token = await getAccessToken(inbox.gmail_refresh_token_encrypted);
    if (!token.ok) return { sent: 0, failed: [`token: ${token.error}`] };
    return await sendNotificationWithToken({ accessToken: token.accessToken, fromEmail: inbox.email }, message);
  } catch (err) {
    console.warn("[notify] failed:", (err as Error).message);
    return { sent: 0, failed: [(err as Error).message] };
  }
}
