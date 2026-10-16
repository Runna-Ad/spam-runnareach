/**
 * Pure MIME builder for outbound Gmail sends: headers, quoted-printable bodies,
 * the HTML rendering of the plain-text pitch, and the compliance footer.
 *
 * No I/O and no imports, so it is unit-tested directly (tests/gmail-mime.test.ts).
 * lib/gmail/client.ts wraps it with the token exchange and the API call.
 *
 * Format: multipart/alternative with text/plain + text/html parts. The HTML part
 * renders the CTA line (starting with 👉) as a styled button while keeping the rest
 * plain-text-like for deliverability. Spam filters read both parts.
 */

export type MimeMessageInput = {
  /** The Gmail address authorised to send (inbox.email). */
  fromEmail: string;
  /** Display name shown to recipient, e.g. "Pedro De Velasco". */
  fromName: string;
  to: string;
  subject: string;
  /**
   * Plain-text body — line breaks (\n) preserved. Lines starting with 👉 are
   * converted to a CTA button in the HTML version.
   */
  body: string;
  /** Optional Reply-To (defaults to fromEmail). */
  replyTo?: string;
  /**
   * Recipient's language. Decides the CTA button label and the HTML lang.
   * A bare "👉 <link>" CTA has no prose to sniff, so guessing from the text
   * produced English buttons on Spanish emails.
   */
  lang?: "en" | "es";
  /** RFC 5322 Message-ID of the message being replied to, for threading. */
  originalMessageId?: string;
  /**
   * Compliance footer (sender identity, mailing address, unsubscribe line).
   * Appended to the text part and rendered small and grey in the HTML part.
   * A plain string has its URLs linkified as-is; the { text, html } form
   * supplies HTML with labelled links ("unsubscribe") so no URL shows.
   */
  footer?: string | { text: string; html: string };
  /** RFC 2369 List-Unsubscribe targets; an https URL also gets RFC 8058 one-click. */
  listUnsubscribe?: { url?: string; mailto?: string };
  /** Fixed values for deterministic tests. */
  date?: Date;
  boundary?: string;
};

const DEFAULT_BOUNDARY = "==Runna_Outreach_Boundary==";

export function buildRfc2822(input: MimeMessageInput): string {
  const boundary = input.boundary ?? DEFAULT_BOUNDARY;
  const replyTo = cleanAddress(input.replyTo ?? input.fromEmail);
  const date = (input.date ?? new Date()).toUTCString();

  const headerLines = [
    `From: ${formatAddress(input.fromName, input.fromEmail)}`,
    `To: ${formatRecipient(input.to)}`,
    `Reply-To: ${replyTo}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  // RFC 2822 threading headers — required for proper threading in email clients
  if (input.originalMessageId) {
    const id = input.originalMessageId.replace(/[\r\n<>\s]/g, "");
    headerLines.push(`In-Reply-To: <${id}>`);
    headerLines.push(`References: <${id}>`);
  }

  const unsub = listUnsubscribeHeaders(input.listUnsubscribe);
  headerLines.push(...unsub);

  const footerText = typeof input.footer === "string" ? input.footer : input.footer?.text;
  const textBody = footerText ? `${input.body}\n\n${footerText}` : input.body;
  const htmlBody = buildHtmlBody(input.body, input.lang, input.footer);

  const textPart = [
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    encodeQuotedPrintable(textBody),
  ].join("\r\n");

  const htmlPart = [
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    encodeQuotedPrintable(htmlBody),
  ].join("\r\n");

  return `${headerLines.join("\r\n")}\r\n\r\n${textPart}\r\n\r\n${htmlPart}\r\n\r\n--${boundary}--`;
}

function listUnsubscribeHeaders(target: MimeMessageInput["listUnsubscribe"]): string[] {
  if (!target) return [];
  const parts: string[] = [];
  if (target.mailto) parts.push(`<mailto:${target.mailto.replace(/[\r\n<>\s]/g, "")}>`);
  const url = target.url && /^https:\/\//.test(target.url) ? target.url.replace(/[\r\n<>\s]/g, "") : null;
  if (url) parts.push(`<${url}>`);
  if (parts.length === 0) return [];
  const headers = [`List-Unsubscribe: ${parts.join(", ")}`];
  // RFC 8058: one-click needs an https URL that accepts a POST with no further interaction.
  if (url) headers.push(`List-Unsubscribe-Post: List-Unsubscribe=One-Click`);
  return headers;
}

// ── Header encoding ───────────────────────────────────────────────────────────

/** Strip anything that could start a new header line or break an address. */
function cleanAddress(email: string): string {
  return email.replace(/[\r\n\s<>"]/g, "");
}

/**
 * Callers pass either a bare address or `"Name" <address>`. Split the second
 * form so the name is encoded and the address cleaned, instead of stripping
 * the brackets and gluing the two together.
 */
export function formatRecipient(to: string): string {
  const named = to.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/s);
  if (named) return formatAddress(named[1]?.replace(/^"|"$/g, ""), named[2] ?? "");
  return cleanAddress(to);
}

/** `"Name" <email>`, RFC 2047-encoding a non-ASCII display name. */
export function formatAddress(name: string | undefined, email: string): string {
  const addr = cleanAddress(email);
  const clean = (name ?? "").replace(/[\r\n"]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return addr;
  if (/^[\x20-\x7E]*$/.test(clean)) return `"${clean}" <${addr}>`;
  return `${encodeHeaderValue(clean)} <${addr}>`;
}

/**
 * Header value safe for the wire: CR/LF can never inject a header, and non-ASCII
 * becomes RFC 2047 UTF-8 base64 encoded-words of at most 75 characters each,
 * split on code-point boundaries and folded onto continuation lines.
 */
export function encodeHeaderValue(value: string): string {
  const flat = value.replace(/[\r\n]+/g, " ");
  if (/^[\x20-\x7E]*$/.test(flat)) return flat;
  const words: string[] = [];
  let chunk = "";
  for (const ch of flat) {
    // 45 bytes → 60 base64 chars + 12 for "=?UTF-8?B?" and "?=" = 72 ≤ 75.
    if (chunk && Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words
    .map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

// ── Quoted-printable (RFC 2045 §6.7) ──────────────────────────────────────────

const QP_LINE_MAX = 76;

/**
 * Encode text as quoted-printable with CRLF line endings.
 *
 * Soft line breaks only ever fall BETWEEN whole tokens, so an escape like "=C3"
 * is never split across lines. The previous encoder cut every 75 characters
 * regardless, which turned "según" into "seg=C3=\r\nBAn" — undecodable — on
 * roughly a third of long lines containing accents.
 */
export function encodeQuotedPrintable(text: string): string {
  return text.replace(/\r\n/g, "\n").split("\n").map(encodeQpLine).join("\r\n");
}

function encodeQpLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  const tokens: string[] = [];
  for (const [i, b] of bytes.entries()) {
    const isLast = i === bytes.length - 1;
    // Printable ASCII except "=" stays literal. Space/tab stay literal except at
    // the end of a line, where transports may strip them (rule 3).
    const literal = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !isLast);
    tokens.push(literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`);
  }

  const out: string[] = [];
  let current = "";
  for (const token of tokens) {
    // Leave room for the "=" soft break so no physical line exceeds 76.
    if (current.length + token.length > QP_LINE_MAX - 1) {
      out.push(`${current}=`);
      current = "";
    }
    current += token;
  }
  out.push(current);
  return out.join("\r\n");
}

// ── HTML body ─────────────────────────────────────────────────────────────────

/**
 * Converts the plain-text pitch body into a minimal HTML email.
 * The email looks like a plain-text message — no images, no complex layout —
 * but lines starting with 👉 are rendered as a styled CTA button.
 *
 * Deliverability notes:
 * - No tracking pixels, no external images
 * - Minimal inline CSS only (no external stylesheets)
 * - multipart/alternative means spam filters score the plain-text part too
 */
export function buildHtmlBody(
  plainText: string,
  lang?: "en" | "es",
  footer?: string | { text: string; html: string },
): string {
  const lines = plainText.split("\n");
  const htmlLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // CTA line — render as button
    if (trimmed.startsWith("👉")) {
      const withoutEmoji = trimmed.replace(/^👉\s*/, "");
      // Extract the URL from ANYWHERE in the line (the CTA is now conversational,
      // so the link sits mid-sentence with text after it). Strip trailing
      // sentence punctuation that the greedy \S+ match swallows (e.g. the period
      // after "...?market=ca.").
      const rawMatch = withoutEmoji.match(/https?:\/\/\S+/);
      const rawUrl = rawMatch ? rawMatch[0] : null;
      const url = rawUrl ? rawUrl.replace(/[.,;:!?)\]]+$/, "") : null;

      if (rawUrl && url) {
        // Split the line into lead-in (before the link) and closer (after it),
        // so it renders: description → button → "reach out / no harm" closer.
        const [beforeRaw = "", afterRaw = ""] = withoutEmoji.split(rawUrl);
        const before = beforeRaw.replace(/[:\s—–-]+$/, "").trim();
        const after = afterRaw.replace(/^[.,:\s—–-]+/, "").trim();
        const buttonText = deriveButtonText(before || after, lang);

        if (before) {
          htmlLines.push(`<p style="margin: 16px 0 8px;">${escapeHtml(before)}</p>`);
        }
        // Wrap the label in a <span> with its own color. Apple Mail (and some
        // dark-mode clients) override the text color on an <a> with their accent
        // blue and add an underline — the inner span with explicit color +
        // text-decoration:none keeps the button white-on-dark everywhere.
        htmlLines.push(
          `<p style="margin: 16px 0;">` +
          `<a href="${escapeHtml(url)}" ` +
          `style="display: inline-block; background-color: #775cbf; border-radius: 8px; ` +
          `text-decoration: none;">` +
          `<span style="display: inline-block; padding: 13px 26px; color: #ffffff; ` +
          `text-decoration: none; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; ` +
          `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;">` +
          `${escapeHtml(buttonText)}` +
          `</span></a></p>`,
        );
        // The closing line (e.g. "See something worth fixing? Reach out. If not,
        // no harm done.") renders under the button — keeps the low-pressure ask visible.
        if (after) {
          htmlLines.push(`<p style="margin: 8px 0 0; line-height: 1.6;">${escapeHtml(after)}</p>`);
        }
      } else {
        // No URL found — render as plain line
        htmlLines.push(`<p style="margin: 8px 0;">${escapeHtml(withoutEmoji)}</p>`);
      }
      continue;
    }

    // Empty line — paragraph break (skip, handled by paragraph wrapping)
    if (trimmed === "") {
      htmlLines.push(`<p style="margin: 0; line-height: 1.6;">&nbsp;</p>`);
      continue;
    }

    // Regular line
    htmlLines.push(`<p style="margin: 0; line-height: 1.6;">${escapeHtml(trimmed)}</p>`);
  }

  if (footer) {
    const inner =
      typeof footer === "string"
        ? footer
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => `<p style="margin: 0;">${linkify(l)}</p>`)
            .join("\n")
        : footer.html;
    htmlLines.push(
      `<div style="margin-top: 28px; padding-top: 12px; border-top: 1px solid #e5e5e5; ` +
        `color: #8a8a8a; font-size: 12px; line-height: 1.5;">\n${inner}\n</div>`,
    );
  }

  return `<!DOCTYPE html>
<html lang="${lang === "es" ? "es" : "en"}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px 20px; font-size: 15px; background: #ffffff;">
${htmlLines.join("\n")}
</body>
</html>`;
}

/** Escape a line and turn its https URLs into plain grey links. */
function linkify(line: string): string {
  const parts = line.split(/(https:\/\/\S+)/);
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? `<a href="${escapeHtml(part)}" style="color: #8a8a8a; text-decoration: underline;">${escapeHtml(part)}</a>`
        : escapeHtml(part),
    )
    .join("");
}

/** Derive a short action-oriented button label from the CTA description text. */
export function deriveButtonText(description: string, lang?: "en" | "es"): string {
  const lower = description.toLowerCase();
  // Language wins over keyword sniffing — see the note in pitches-page.tsx.
  // A bare "👉 {link}" CTA has no prose to sniff, so Spanish emails were
  // getting the English fallback label.
  if (lang === "es") return "Ver diagnóstico gratis →";
  // Spanish
  if (lower.includes("gratis") || lower.includes("diagnóstico") || lower.includes("auditoría") || lower.includes("auditoria")) {
    return "Ver diagnóstico gratis →";
  }
  if (lower.includes("fugas") || lower.includes("pierde") || lower.includes("número")) {
    return "Ver diagnóstico gratis →";
  }
  // English — lean into the self-serve "see for yourself, it's the data" framing.
  if (lower.includes("see for yourself") || lower.includes("the data") || lower.includes("free tool") || lower.includes("free platform")) {
    return "See it for yourself →";
  }
  if (lower.includes("audit") || lower.includes("leak") || lower.includes("losing")) {
    return "Run my free audit →";
  }
  if (lower.includes("number") || lower.includes("revenue")) {
    return "See your store's number →";
  }
  // Fallback
  return "Run my free audit →";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
