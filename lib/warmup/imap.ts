// ─────────────────────────────────────────────────────────────────────────────
// lib/warmup/imap.ts
// IMAP helpers using imapflow — check inbox delivery + send replies.
// ─────────────────────────────────────────────────────────────────────────────

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { WarmupBuddy } from "./types";

// ── Credential resolution ──────────────────────────────────────────────────────

export function resolveBuddyCredentials(buddy: WarmupBuddy): {
  email: string;
  appPassword: string;
} | null {
  const email = process.env[buddy.email_env_var];
  const appPassword = process.env[buddy.app_password_secret];

  if (!email || !appPassword) {
    console.warn(
      `[warmup/imap] Missing env vars for buddy ${buddy.id}: ` +
      `${buddy.email_env_var}=${email ? "ok" : "missing"}, ` +
      `${buddy.app_password_secret}=${appPassword ? "ok" : "missing"}`,
    );
    return null;
  }

  return { email, appPassword };
}

// ── IMAP client factory ────────────────────────────────────────────────────────

function makeImapClient(
  host: string,
  port: number,
  email: string,
  appPassword: string,
): ImapFlow {
  return new ImapFlow({
    host,
    port,
    secure: true,
    auth: {
      user: email,
      pass: appPassword,
    },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

// ── Check if a specific message landed in Inbox ────────────────────────────────

export type InboxCheckResult = {
  messageId: string;
  foundInInbox: boolean;
  foundInSpam: boolean;
  movedToInbox: boolean;
};

/**
 * Connect to buddy's Gmail via IMAP, search for a message by Message-Id header,
 * determine whether it landed in INBOX or spam, and if in spam move it to Inbox.
 */
export async function checkMessageInbox(
  buddy: WarmupBuddy,
  messageId: string,
): Promise<InboxCheckResult | null> {
  const creds = resolveBuddyCredentials(buddy);
  if (!creds) return null;

  const client = makeImapClient(
    "imap.gmail.com",
    993,
    creds.email,
    creds.appPassword,
  );

  const result: InboxCheckResult = {
    messageId,
    foundInInbox: false,
    foundInSpam: false,
    movedToInbox: false,
  };

  try {
    await client.connect();

    // Search INBOX first
    await client.mailboxOpen("INBOX");
    const inboxSeqs = await client.search({ header: { "message-id": messageId } });
    if (Array.isArray(inboxSeqs) && inboxSeqs.length > 0) {
      result.foundInInbox = true;
      return result;
    }

    // Try English spam folder name
    const spamFolders = ["[Gmail]/Spam", "[Gmail]/Correo no deseado"];
    for (const folder of spamFolders) {
      try {
        await client.mailboxOpen(folder);
        const spamSeqs = await client.search({ header: { "message-id": messageId } });
        if (Array.isArray(spamSeqs) && spamSeqs.length > 0) {
          result.foundInSpam = true;
          await client.messageMove(spamSeqs as number[], "INBOX");
          result.movedToInbox = true;
          break;
        }
      } catch {
        // Folder doesn't exist — try next
      }
    }
  } catch (err) {
    console.error(`[warmup/imap] checkMessageInbox error for buddy ${buddy.id}:`, err);
    return null;
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }

  return result;
}

// ── Send a reply from buddy account via SMTP ──────────────────────────────────

export type ReplyResult = {
  sent: boolean;
  inReplyToMessageId: string;
};

export async function sendBuddyReply(
  buddy: WarmupBuddy,
  inReplyToMessageId: string,
  senderEmail: string,
  subject: string,
  replyBody: string,
): Promise<ReplyResult> {
  const creds = resolveBuddyCredentials(buddy);
  if (!creds) return { sent: false, inReplyToMessageId };

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: creds.email,
      pass: creds.appPassword,
    },
  });

  try {
    await transporter.sendMail({
      from: `"${buddy.display_name || "Friend"}" <${creds.email}>`,
      to: senderEmail,
      subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
      text: replyBody,
      inReplyTo: inReplyToMessageId,
      references: inReplyToMessageId,
    });
    return { sent: true, inReplyToMessageId };
  } catch (err) {
    console.error(`[warmup/imap] sendBuddyReply error:`, err);
    return { sent: false, inReplyToMessageId };
  }
}

// ── Process incoming warmup emails — find unread, reply, mark read ────────────

export async function processIncomingWarmupEmails(
  buddy: WarmupBuddy,
  warmupSenderEmail: string,
  replyTemplates: Array<{ subject: string; reply_text: string }>,
): Promise<number> {
  const creds = resolveBuddyCredentials(buddy);
  if (!creds) return 0;

  const client = makeImapClient("imap.gmail.com", 993, creds.email, creds.appPassword);
  let repliedCount = 0;

  try {
    await client.connect();
    await client.mailboxOpen("INBOX");

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // imapflow: `seen: false` means unseen (unread)
    const seqs = await client.search({ seen: false, from: warmupSenderEmail, since });

    if (!Array.isArray(seqs) || seqs.length === 0) return 0;

    for (const seq of seqs as number[]) {
      try {
        const msg = await client.fetchOne(String(seq), { envelope: true });
        if (!msg || !msg.envelope) continue;

        const originalSubject = msg.envelope.subject ?? "";
        const msgId = msg.envelope.messageId ?? "";

        const template = replyTemplates[Math.floor(Math.random() * replyTemplates.length)];
        const replyBody = template?.reply_text ?? "Thanks! Talk soon.";

        const replyResult = await sendBuddyReply(
          buddy,
          msgId,
          warmupSenderEmail,
          originalSubject,
          replyBody,
        );

        if (replyResult.sent) {
          await client.messageFlagsAdd(String(seq), ["\\Seen"]);
          repliedCount++;
        }
      } catch (msgErr) {
        console.error(`[warmup/imap] processIncoming message error:`, msgErr);
      }
    }
  } catch (err) {
    console.error(`[warmup/imap] processIncomingWarmupEmails error:`, err);
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }

  return repliedCount;
}

