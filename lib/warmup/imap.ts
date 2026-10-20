// ─────────────────────────────────────────────────────────────────────────────
// lib/warmup/imap.ts
// IMAP helpers using imapflow — check inbox delivery + send replies.
//
// Every connection dies as a normal failure: an `error` listener on each
// client (an unhandled 'error' event is an uncaught exception, Sentry SPAM-6),
// no hidden auto-IDLE, every command awaited inside a try, and no IMAP
// connection is held open while a buddy reply goes out over SMTP.
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

/** The part of ImapFlow this module uses, so tests can inject a fake. */
export interface ImapClientLike {
  connect(): Promise<void>;
  mailboxOpen(path: string): Promise<unknown>;
  search(query: { header?: Record<string, string>; seen?: boolean; from?: string; since?: Date }, options?: { uid?: boolean }): Promise<number[] | false>;
  messageMove(range: number[], destination: string, options?: { uid?: boolean }): Promise<unknown>;
  fetchOne(range: string, query: { envelope: true }, options?: { uid?: boolean }): Promise<{ envelope?: { subject?: string; messageId?: string } } | false>;
  messageFlagsAdd(range: number[], flags: string[], options?: { uid?: boolean }): Promise<unknown>;
  logout(): Promise<void>;
  close(): void;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type ImapClientFactory = (host: string, port: number, email: string, appPassword: string) => ImapClientLike;

export function imapClientOptions(host: string, port: number, email: string, appPassword: string) {
  return {
    host,
    port,
    secure: true,
    auth: {
      user: email,
      pass: appPassword,
    },
    logger: false as const,
    // imapflow IDLEs 15s after any command in a selected mailbox unless told
    // not to. We never wait on the server, so an IDLE only keeps a socket
    // alive past the point we are done with it.
    disableAutoIdle: true,
    connectionTimeout: 8_000,   // was 15s — cut to fail fast on hung connections
    greetingTimeout: 5_000,    // was 10s
    socketTimeout: 12_000,     // was 30s — single stuck socket was eating ~30s of the 60s budget
  };
}

const makeImapClient: ImapClientFactory = (host, port, email, appPassword) =>
  new ImapFlow(imapClientOptions(host, port, email, appPassword));

/** Builds a client that can never throw an 'error' event at the process. */
function openClient(make: ImapClientFactory, buddy: WarmupBuddy, email: string, appPassword: string): ImapClientLike {
  const client = make("imap.gmail.com", 993, email, appPassword);
  client.on("error", (err) => {
    console.warn(`[warmup/imap] connection error for buddy ${buddy.id}: ${err?.message ?? String(err)}`);
  });
  return client;
}

/** Log out politely; on a dead connection just drop it. Never throws. */
async function endClient(client: ImapClientLike): Promise<void> {
  try {
    await client.logout();
  } catch {
    try { client.close(); } catch { /* already closed */ }
  }
}

/**
 * Close the client after `ms`: imapflow's close() rejects whatever command is
 * in flight (logout included), so the awaits unwind into their catch. A real
 * cancel, not a race. Returns the function that disarms it.
 */
function capClient(client: ImapClientLike, ms: number, what: string, buddy: WarmupBuddy): () => void {
  const timer = setTimeout(() => {
    console.warn(`[warmup/imap] ${what} cut off after ${ms}ms for buddy ${buddy.id}`);
    try { client.close(); } catch { /* already closed */ }
  }, ms);
  return () => clearTimeout(timer);
}

/** The connection itself is gone: stop, no later command can succeed. */
function isConnectionLost(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "NoConnection" || code === "ETIMEOUT" || code === "ECONNRESET" || code === "EPIPE";
}

// ── Check if a specific message landed in Inbox ────────────────────────────────

export type InboxCheckResult = {
  messageId: string;
  foundInInbox: boolean;
  foundInSpam: boolean;
  movedToInbox: boolean;
};

export type InboxCheckOptions = {
  /** Hard cap on the whole check: the connection is closed when it is reached. */
  timeoutMs?: number;
  makeClient?: ImapClientFactory;
};

/**
 * Connect to buddy's Gmail via IMAP, search for a message by Message-Id header,
 * determine whether it landed in INBOX or spam, and if in spam move it to Inbox.
 * Null = not measured (no credentials, not found, connection failed or timed out).
 */
export async function checkMessageInbox(
  buddy: WarmupBuddy,
  messageId: string,
  options: InboxCheckOptions = {},
): Promise<InboxCheckResult | null> {
  const creds = resolveBuddyCredentials(buddy);
  if (!creds) return null;

  const client = openClient(options.makeClient ?? makeImapClient, buddy, creds.email, creds.appPassword);
  const uncap = options.timeoutMs !== undefined
    ? capClient(client, options.timeoutMs, "checkMessageInbox", buddy)
    : () => {};

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

    // Check Gmail category tabs — cold-domain emails often land in Promotions, not Primary
    const inboxLikeFolders = [
      "[Gmail]/Category Promotions",
      "[Gmail]/Category Updates",
      "[Gmail]/Category Social",
    ];
    for (const folder of inboxLikeFolders) {
      try {
        await client.mailboxOpen(folder);
        const seqs = await client.search({ header: { "message-id": messageId } });
        if (Array.isArray(seqs) && seqs.length > 0) {
          // Landed in a category tab — counts as inbox-delivered (not spam)
          result.foundInInbox = true;
          // Move to Primary INBOX so future checks are consistent
          try { await client.messageMove(seqs, "INBOX"); } catch { /* best-effort */ }
          return result;
        }
      } catch (err) {
        if (isConnectionLost(err)) throw err;
        // Folder doesn't exist on this account — try next
      }
    }

    // Check spam folders before All Mail: a spam placement is the one the
    // spam pause and the autopilot's placement breaker need, so it must not
    // wait behind a slow All Mail search.
    const spamFolders = ["[Gmail]/Spam", "[Gmail]/Correo no deseado"];
    for (const folder of spamFolders) {
      try {
        await client.mailboxOpen(folder);
        const spamSeqs = await client.search({ header: { "message-id": messageId } });
        if (Array.isArray(spamSeqs) && spamSeqs.length > 0) {
          result.foundInSpam = true;
          await client.messageMove(spamSeqs, "INBOX");
          result.movedToInbox = true;
          return result;
        }
      } catch (err) {
        // Found in spam but the rescue failed: still a spam placement.
        if (result.foundInSpam) return result;
        if (isConnectionLost(err)) throw err;
        // Folder doesn't exist — try next
      }
    }

    // All Mail = delivered (archived or labelled); Gmail keeps spam out of it.
    // Never move from here: a MOVE expunges from All Mail, which Gmail treats
    // as a delete.
    const allMailFolders = [
      "[Gmail]/All Mail",
      "[Gmail]/Todas las conversaciones", // ES
    ];
    for (const folder of allMailFolders) {
      try {
        await client.mailboxOpen(folder);
        const seqs = await client.search({ header: { "message-id": messageId } });
        if (Array.isArray(seqs) && seqs.length > 0) {
          result.foundInInbox = true;
          return result;
        }
      } catch (err) {
        if (isConnectionLost(err)) throw err;
        // Folder doesn't exist on this account — try next
      }
    }

    // If not found anywhere, return null so landed_in_inbox stays null (pending)
    // rather than being incorrectly counted as spam
    if (!result.foundInInbox && !result.foundInSpam) {
      return null;
    }
  } catch (err) {
    console.error(`[warmup/imap] checkMessageInbox error for buddy ${buddy.id}:`, err);
    return null;
  } finally {
    // The cap covers the logout too: a server that never answers LOGOUT
    // would otherwise add a full socketTimeout.
    await endClient(client);
    uncap();
  }

  return result;
}

// ── Send a reply from buddy account via SMTP ──────────────────────────────────

/**
 * Worst case of one buddy reply: the SMTP timeouts below added up. nodemailer
 * cannot cancel a non-pooled send, so this is a bound by timeouts, not a timer.
 */
export const SMTP_WORST_MS = 8_000 + 5_000 + 10_000;
/** One IMAP phase of reply processing (read, or mark read) is cut off after this. */
export const IMAP_PHASE_MAX_MS = 15_000;
/** What can still run after the reply deadline: one reply in flight, then mark-read. */
export const REPLY_TAIL_MS = SMTP_WORST_MS + IMAP_PHASE_MAX_MS;

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
    // nodemailer's defaults (2 min connect, 1 h socket) outlive the route.
    // Their sum is SMTP_WORST_MS.
    connectionTimeout: 8_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
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
  } finally {
    transporter.close();
  }
}

// ── Process incoming warmup emails — find unread, reply, mark read ────────────

export type IncomingDeps = {
  makeClient?: ImapClientFactory;
  sendReply?: typeof sendBuddyReply;
  /** Epoch ms. No read and no reply starts after it; marking sent replies read still runs. */
  deadline?: number;
  now?: () => number;
};

/**
 * Three phases so no IMAP socket sits idle (and times out) during an SMTP send:
 * read the unread warm-up mails and disconnect, reply over SMTP, then reconnect
 * once to mark the replied ones read (by UID, which survives the reconnect).
 * Each IMAP phase is capped at IMAP_PHASE_MAX_MS; replies stop at the deadline
 * or at the first SMTP failure (the next one would most likely fail the same way).
 */
export async function processIncomingWarmupEmails(
  buddy: WarmupBuddy,
  warmupSenderEmail: string,
  replyTemplates: Array<{ subject: string; reply_text: string }>,
  deps: IncomingDeps = {},
): Promise<number> {
  const creds = resolveBuddyCredentials(buddy);
  if (!creds) return 0;

  const make = deps.makeClient ?? makeImapClient;
  const sendReply = deps.sendReply ?? sendBuddyReply;
  const now = deps.now ?? Date.now;
  const pastDeadline = () => deps.deadline !== undefined && now() >= deps.deadline;
  if (pastDeadline()) return 0;

  // ── 1. Read
  const incoming: Array<{ uid: number; subject: string; messageId: string }> = [];
  const reader = openClient(make, buddy, creds.email, creds.appPassword);
  const uncapReader = capClient(reader, IMAP_PHASE_MAX_MS, "processIncoming read", buddy);
  try {
    await reader.connect();
    await reader.mailboxOpen("INBOX");

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // imapflow: `seen: false` means unseen (unread)
    const uids = await reader.search({ seen: false, from: warmupSenderEmail, since }, { uid: true });

    for (const uid of Array.isArray(uids) ? uids : []) {
      const msg = await reader.fetchOne(String(uid), { envelope: true }, { uid: true });
      if (!msg || !msg.envelope) continue;
      incoming.push({ uid, subject: msg.envelope.subject ?? "", messageId: msg.envelope.messageId ?? "" });
    }
  } catch (err) {
    console.error(`[warmup/imap] processIncomingWarmupEmails read error for buddy ${buddy.id}:`, err);
    // A partial read is dropped: replying to mail we may not get to mark read
    // would reply twice tomorrow.
    return 0;
  } finally {
    await endClient(reader);
    uncapReader();
  }

  if (incoming.length === 0) return 0;

  // ── 2. Reply (no IMAP connection open)
  const replied: number[] = [];
  for (const msg of incoming) {
    if (pastDeadline()) break;
    const template = replyTemplates[Math.floor(Math.random() * replyTemplates.length)];
    const replyBody = template?.reply_text ?? "Thanks! Talk soon.";
    try {
      const replyResult = await sendReply(buddy, msg.messageId, warmupSenderEmail, msg.subject, replyBody);
      if (!replyResult.sent) break;
      replied.push(msg.uid);
    } catch (err) {
      console.error(`[warmup/imap] processIncoming reply error for buddy ${buddy.id}:`, err);
      break;
    }
  }

  if (replied.length === 0) return 0;

  // ── 3. Mark replied mail read
  const writer = openClient(make, buddy, creds.email, creds.appPassword);
  const uncapWriter = capClient(writer, IMAP_PHASE_MAX_MS, "processIncoming mark-read", buddy);
  try {
    await writer.connect();
    await writer.mailboxOpen("INBOX");
    await writer.messageFlagsAdd(replied, ["\\Seen"], { uid: true });
  } catch (err) {
    console.error(`[warmup/imap] processIncoming mark-read error for buddy ${buddy.id}:`, err);
  } finally {
    await endClient(writer);
    uncapWriter();
  }

  return replied.length;
}
