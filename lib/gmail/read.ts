/**
 * Gmail API thread reader — pulls inbound replies for the Reply Funnel.
 *
 * Why the Gmail API (not IMAP): the sending inboxes (`sender_inboxes`)
 * authenticate via OAuth refresh tokens, not app passwords. Warmup's IMAP
 * path (lib/warmup/imap.ts) uses per-buddy app passwords which sender inboxes
 * don't have. We already store gmail_thread_id + gmail_message_id on every
 * sent pitch, so threads.get with the OAuth token we already mint for sending
 * gives us exact, in-thread reply fidelity with zero new credentials.
 */

const THREADS_GET_URL = "https://gmail.googleapis.com/gmail/v1/users/me/threads";

// Gmail meters each mailbox per minute. The reply poll reads every sent thread
// back to back, and past ~50 in a burst every other read came back 403 "Quota
// exceeded … per minute per user", so half the threads went unchecked. That is
// a pace problem, not a failure: wait and read again.
const RATE_LIMIT_RETRIES = 3;

export function isRateLimited(status: number, body: string): boolean {
  return status === 429 || (status === 403 && /rateLimitExceeded|Quota exceeded/i.test(body));
}

export type InboundReply = {
  /** Gmail's internal message id (used for dedupe + threading on our send). */
  gmailMessageId: string;
  /** RFC 2822 Message-ID header value (the <...@mail.gmail.com> token). */
  rfcMessageId: string | null;
  fromEmail: string;
  fromName: string | null;
  subject: string | null;
  bodyText: string;
  /** Epoch ms when Gmail received the message. */
  internalDate: number;
};

type GmailHeader = { name: string; value: string };
type GmailPart = {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};
type GmailMessage = {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: GmailPart;
};
type GmailThread = { id: string; messages?: GmailMessage[] };

function header(msg: GmailMessage, name: string): string | null {
  const headers = msg.payload?.headers ?? [];
  const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found?.value ?? null;
}

/** Recursively pull the best text/plain body out of a Gmail payload tree. */
function extractTextBody(part: GmailPart | undefined): string {
  if (!part) return "";
  // Leaf with data
  if (part.body?.data && (part.mimeType === "text/plain" || !part.mimeType)) {
    return decodeB64Url(part.body.data);
  }
  if (part.parts && part.parts.length > 0) {
    // Prefer text/plain anywhere in the subtree
    for (const child of part.parts) {
      if (child.mimeType === "text/plain" && child.body?.data) {
        return decodeB64Url(child.body.data);
      }
    }
    // Fall back to recursing (multipart/alternative, multipart/mixed, etc.)
    for (const child of part.parts) {
      const text = extractTextBody(child);
      if (text.trim()) return text;
    }
  }
  // Last resort: a text/html leaf, stripped of tags
  if (part.body?.data && part.mimeType === "text/html") {
    return stripHtml(decodeB64Url(part.body.data));
  }
  return "";
}

function decodeB64Url(data: string): string {
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Parse a "Name <email@x.com>" From header into its parts. */
function parseFrom(raw: string | null): { email: string; name: string | null } {
  if (!raw) return { email: "", name: null };
  const match = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (match) {
    const name = match[1]?.trim() || null;
    return { email: (match[2] ?? "").trim().toLowerCase(), name };
  }
  return { email: raw.trim().toLowerCase(), name: null };
}

/**
 * Fetch a thread and return inbound messages (NOT from our own inbox).
 * Caller dedupes by gmailMessageId against the `replies` table.
 *
 * @param ourEmails  addresses we send FROM — any message from these is ours.
 */
export async function fetchThreadReplies(
  accessToken: string,
  threadId: string,
  ourEmails: string[],
): Promise<{ ok: true; replies: InboundReply[] } | { ok: false; error: string }> {
  const ours = new Set(ourEmails.map((e) => e.toLowerCase()));

  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${THREADS_GET_URL}/${encodeURIComponent(threadId)}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) break;
    const body = await res.text().catch(() => "");
    if (attempt >= RATE_LIMIT_RETRIES || !isRateLimited(res.status, body)) {
      return { ok: false, error: `threads.get failed (${res.status}): ${body.slice(0, 200)}` };
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt));
  }

  const thread = (await res.json()) as GmailThread;
  const messages = thread.messages ?? [];
  const replies: InboundReply[] = [];

  for (const msg of messages) {
    const from = parseFrom(header(msg, "From"));
    if (!from.email || ours.has(from.email)) continue; // skip our own sends

    replies.push({
      gmailMessageId: msg.id,
      rfcMessageId: stripAngle(header(msg, "Message-ID")),
      fromEmail: from.email,
      fromName: from.name,
      subject: header(msg, "Subject"),
      bodyText: extractTextBody(msg.payload).trim(),
      internalDate: msg.internalDate ? Number.parseInt(msg.internalDate, 10) : 0,
    });
  }

  return { ok: true, replies };
}

function stripAngle(raw: string | null): string | null {
  if (!raw) return null;
  return raw.replace(/^</, "").replace(/>$/, "").trim() || null;
}

const MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

/**
 * The RFC 5322 Message-ID header (without angle brackets) of a message in the
 * caller's own mailbox, from Gmail's internal id. messages.send returns only
 * the internal id, but another mailbox (a warmup buddy's, over IMAP) can only
 * find the message by its Message-ID header. Null when it can't be read.
 */
export async function fetchRfcMessageId(accessToken: string, gmailMessageId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${MESSAGES_URL}/${encodeURIComponent(gmailMessageId)}?format=metadata&metadataHeaders=Message-ID`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return null;
    const msg = (await res.json()) as GmailMessage;
    return stripAngle(header(msg, "Message-ID"));
  } catch {
    return null;
  }
}

/**
 * Look in the sender's Sent folder for a message to `to` with exactly `subject`,
 * sent after `afterEpochSec`. The source of truth for "did that send actually
 * happen?" when a send was interrupted and our own row can't say.
 */
export async function findSentMessage(
  accessToken: string,
  args: { to: string; subject: string; afterEpochSec: number },
): Promise<{ ok: true; found: { id: string; threadId: string; internalDate: number } | null } | { ok: false; error: string }> {
  const q = `in:sent to:${args.to} after:${Math.floor(args.afterEpochSec)}`;
  const list = await fetch(`${MESSAGES_URL}?maxResults=10&q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!list.ok) {
    const body = await list.text().catch(() => "");
    return { ok: false, error: `messages.list failed (${list.status}): ${body.slice(0, 200)}` };
  }
  const json = (await list.json()) as { messages?: Array<{ id: string; threadId: string }> };
  for (const m of json.messages ?? []) {
    const res = await fetch(
      `${MESSAGES_URL}/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=Subject`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return { ok: false, error: `messages.get failed (${res.status})` };
    const msg = (await res.json()) as GmailMessage;
    if ((header(msg, "Subject") ?? "").trim() === args.subject.trim()) {
      return {
        ok: true,
        found: { id: msg.id, threadId: msg.threadId, internalDate: Number.parseInt(msg.internalDate ?? "0", 10) },
      };
    }
  }
  return { ok: true, found: null };
}
