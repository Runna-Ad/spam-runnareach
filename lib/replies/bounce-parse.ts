// Pure NDR (non-delivery report) parsing. Kept out of the cron route so it can
// be unit-tested without pulling in next/server.

/**
 * Did Gmail refuse to SEND our message, rather than the recipient's server
 * refusing the address? Then the address is not the problem: our email is (a
 * flagged link or wording), and the recipient must not be blocked for it.
 *
 * On 2026-11-11 all 4 first emails came back as
 *   "** Message blocked ** Your message to X has been blocked. ...
 *    The response was: Message rejected. For more information, go to
 *    https://support.google.com/mail/answer/69585"
 * to Cisco, Microsoft and self-hosted servers alike: Gmail stopped them because
 * the link host was on Google's phishing list. A recipient server's refusal
 * names it ("The response from the remote server was: 550 5.4.1 Recipient
 * address rejected", a dead mailbox on Microsoft 365, 2026-11-06), so any
 * mention of a remote server keeps the NDR an ordinary hard bounce.
 */
export function isSenderSideBlock(bodyText: string | null | undefined): boolean {
  if (!bodyText) return false;
  const top = bodyText.slice(0, 2000); // the diagnosis sits above the original message
  if (/response from the remote server/i.test(top)) return false;
  return /message blocked|has been blocked/i.test(top) && /the response was:\s*message rejected\b/i.test(top);
}

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
