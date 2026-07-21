// Pure NDR (non-delivery report) parsing. Kept out of the cron route so it can
// be unit-tested without pulling in next/server.

/**
 * Pull the failed recipient out of a non-delivery report.
 *
 * Tries the RFC 3464 machine-readable field first (`Final-Recipient: rfc822;
 * user@host`), then the human phrasings the big providers use. Returns null
 * when nothing can be positively identified — the caller must NOT guess, since
 * a wrong address would be permanently blocked from all future outreach.
 * Never returns our own sender address or a daemon address.
 */
export function extractBouncedRecipient(
  bodyText: string | null | undefined,
  senderEmail: string | null,
): string | null {
  if (!bodyText) return null;
  const body = bodyText.slice(0, 4000); // NDR details are always near the top

  const patterns: RegExp[] = [
    // RFC 3464 DSN field — the authoritative one.
    /final-recipient:\s*rfc822;\s*<?([^\s<>;,]+@[^\s<>;,]+)>?/i,
    /original-recipient:\s*(?:rfc822;)?\s*<?([^\s<>;,]+@[^\s<>;,]+)>?/i,
    // Gmail: "Your message wasn't delivered to someone@example.com because…"
    // Greedy up to whitespace/delimiter — a NON-greedy domain match stops at
    // the first dot and truncates "ana@clinica.mx" to "ana@clinica". Trailing
    // punctuation is stripped below.
    /(?:wasn't|was not|couldn't be|could not be)\s+deliver(?:ed)?\s+to\s+<?([^\s<>,;]+@[^\s<>,;]+)/i,
    // Office 365 / Exchange
    /your message to\s+<?([^\s<>,;]+@[^\s<>,;]+)/i,
    // Generic postfix-style
    /<([^\s<>,]+@[^\s<>,]+)>:\s*(?:host|Recipient address rejected|user unknown)/i,
  ];

  const daemonish = /^(mailer-daemon|postmaster|noreply|no-reply)@/i;
  const own = (senderEmail ?? "").trim().toLowerCase();

  for (const re of patterns) {
    const m = body.match(re);
    const candidate = m?.[1]?.trim().toLowerCase().replace(/[.,;]+$/, "");
    if (!candidate || !candidate.includes("@")) continue;
    if (candidate === own) continue; // that's us, not the dead mailbox
    if (daemonish.test(candidate)) continue;
    return candidate;
  }
  return null;
}
