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

  const res = await fetch(`${THREADS_GET_URL}/${encodeURIComponent(threadId)}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `threads.get failed (${res.status}): ${body.slice(0, 200)}` };
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
