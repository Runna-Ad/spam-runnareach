/**
 * Heuristic reply intent classifier + the deterministic checks the reply poll
 * applies on top of the Claude classifier. Pure functions — no I/O.
 *
 * Three rules shape everything here:
 *   1. Classify only what THEY wrote. Replies quote our email, and our email
 *      now carries an unsubscribe footer (".../api/unsubscribe?t=..."), so a
 *      "yes, interested!" that quotes it would otherwise read as an opt-out.
 *   2. An explicit opt-out ("unsubscribe", "darme de baja", "désabonner") must
 *      never be missed — CASL requires honouring it — so it's checked
 *      deterministically, in all three languages we receive.
 *   3. A temporary delivery delay ("Delivery incomplete … will retry") is not a
 *      bounce. Treating it as one suppressed reachable prospects.
 */

import type { ReplyIntent, ReplySentiment, ReplyUrgency } from "./queries";

export type ClassifyInput = {
  subject: string | null;
  body_text: string | null;
  from_email: string;
};

export type ClassifyResult = {
  intent: ReplyIntent;
  urgency: ReplyUrgency;
  sentiment: ReplySentiment;
  reasoning: string;
};

// ── Quoted-text stripping ──────────────────────────────────────────────────────

/**
 * Where a quoted earlier message starts. Gmail wraps its "On … wrote:" line
 * when the sender name is long, so the attribution may span two lines.
 */
const QUOTE_HEADERS: RegExp[] = [
  /^on [^\n]{0,200}(\n[^\n]{0,120})?wrote:\s*$/im, // Gmail / Apple (EN)
  /^el [^\n]{0,200}(\n[^\n]{0,120})?escribi[oó]:\s*$/im, // Gmail (ES)
  /^le [^\n]{0,200}(\n[^\n]{0,120})?a [ée]crit\s*:\s*$/im, // Gmail (FR)
  /^-{2,}\s*(original message|mensaje original|message d'origine)\s*-{2,}/im,
  /^_{10,}\s*$/m, // Outlook separator
  /^from:\s[^\n]+\n(sent|date):\s/im, // Outlook header block (EN)
  /^de:\s[^\n]+\n(enviado|enviado el|fecha):\s/im, // (ES)
  /^de\s*:\s[^\n]+\n(envoy[ée]|date)\s*:\s/im, // (FR)
];

/** The part of a reply the person actually wrote: no quoted thread, no "> " lines. */
export function stripQuotedReply(body: string | null): string {
  const text = (body ?? "").replace(/\r\n?/g, "\n");
  let cut = text.length;
  for (const re of QUOTE_HEADERS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text
    .slice(0, cut)
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
}

// ── Deterministic checks ───────────────────────────────────────────────────────

/** A mail server saying it will KEEP TRYING — not a bounce, not a reply. */
export function isTemporaryDeliveryDelay(input: ClassifyInput): boolean {
  const text = `${input.subject ?? ""}\n${input.body_text ?? ""}`;
  const fromDaemon = /mailer-daemon|postmaster|mail delivery/i.test(input.from_email ?? "");
  const delay =
    /delivery incomplete|delivery status notification \(delay\)|temporary problem delivering|will (retry|keep trying)|delivery (has been |is )?delayed|message (is )?delayed|still trying to deliver/i.test(
      text,
    );
  const permanent =
    /address not found|could ?n'?t be found|could not be delivered|was ?n'?t delivered|message not delivered|delivery has failed|permanent(ly)? (error|failure|failed)|550[ -]5\./i.test(
      text,
    );
  return delay && !permanent && (fromDaemon || /delivery status notification/i.test(text));
}

/** Unambiguous "stop emailing me", in EN / ES / FR. Run on stripped text. */
const EXPLICIT_OPT_OUT: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bopt[- ]?out\b/i,
  /\bremove (me|us|my email|our email)\b/i,
  /\btake (me|us) off\b/i,
  /\bstop (emailing|sending|contacting|writing)\b/i,
  /\b(do not|don'?t) (contact|email|e-mail) (me|us)\b/i,
  /\bdo not contact\b/i,
  /\bno longer wish to\b/i,
  /\bplease stop\b/i,
  /\b(dar|d[eé]n?|darme|darnos|dame|denme)(me|nos)? de baja\b/i,
  /\b(quiero|solicito|pido|favor de dar) (la |mi |nuestra )?baja\b/i,
  /\bno (me|nos) (escriban|escribas|contacten|contactes|env[ií]en|env[ií]es|mandes|manden)\b/i,
  /\bno (me|nos) (vuelvan|vuelvas|vuelva) a (escribir|contactar|enviar|mandar)/i,
  /\b(dejen|deja|dejar) de (escribir|enviar|mandar)/i,
  /\bs[aá]quen(me|nos)? de (su|la|sus) lista/i,
  /\b(eliminen|borren|eliminar|borrar) (mi|nuestro|nuestros|mis) (correo|datos|email|direcci[oó]n)/i,
  /\bd[ée]sabonn/i,
  /\bd[ée]sinscri/i,
  /\bretirez[- ](moi|nous)\b/i,
  /\bne plus recevoir\b/i,
  /\barr[eê]tez de (m'|nous )?([ée]crire|envoyer)/i,
];

/** One-word replies that are an instruction, e.g. the whole message is "BAJA". */
const OPT_OUT_COMMANDS = new Set(["baja", "unsubscribe", "unsub", "stop", "remove", "remove me", "désabonner", "desabonner"]);

export function isExplicitOptOut(strippedText: string): boolean {
  const firstLine = (strippedText.split("\n").find((l) => l.trim()) ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, "")
    .trim();
  if (OPT_OUT_COMMANDS.has(firstLine)) return true;
  return EXPLICIT_OPT_OUT.some((re) => re.test(strippedText));
}

// ── Heuristic classifier ───────────────────────────────────────────────────────

/**
 * Substring-pattern matcher, the fallback when Claude is unavailable. Order
 * matters — the most specific intents (bounce, auto-reply) come first.
 */
export function classifyReplyHeuristic(input: ClassifyInput): ClassifyResult {
  const subject = input.subject ?? "";
  const own = stripQuotedReply(input.body_text);
  const haystack = `${subject}\n${own}`.toLowerCase();
  const from = (input.from_email ?? "").toLowerCase();

  // 0) A temporary delay is the server saying it will keep trying.
  if (isTemporaryDeliveryDelay(input)) {
    return {
      intent: "auto_reply",
      urgency: "cold",
      sentiment: "neutral",
      reasoning: "Temporary delivery delay — the mail server will retry. Not a bounce.",
    };
  }

  // 1) Bounce / non-delivery report (highest precedence — a dead address is not
  // an OOO and must NOT be snoozed). Detect the daemon sender + classic NDR
  // subject/body phrases (Gmail "Delivery Status Notification (Failure)",
  // Office 365 "Undeliverable", Postfix "failure notice", SMTP 5.x.x codes).
  const fromDaemon =
    /mailer-daemon|postmaster|mail delivery (subsystem|system)|no-?reply.*(deliver|bounce)/i.test(from);
  const ndrPhrases =
    /delivery (status notification|has failed)|undeliverable|mail delivery failed|failure notice|returned mail|could ?n'?t be delivered|was not delivered|wasn'?t found|address (not found|couldn'?t be found|rejected)|recipient (address rejected|not found)|no such (user|address|mailbox)|user unknown|mailbox (unavailable|full|not found)|550[ -]5\.|\b55[0-9]\b.*(unknown|reject|not exist)|permanent (error|failure)/i;
  if (fromDaemon || ndrPhrases.test(`${subject}\n${input.body_text ?? ""}`)) {
    return {
      intent: "bounced",
      urgency: "cold",
      sentiment: "neutral",
      reasoning: fromDaemon
        ? "Non-delivery report from a mail daemon — address is undeliverable."
        : "Bounce / undeliverable language detected.",
    };
  }

  // 2) Auto-reply / out-of-office. Avoid bare "holiday" — "after the holidays"
  // is not_now. EN / ES / FR.
  if (
    /out of (the )?office|automatic reply|auto-reply|on vacation|on leave|on holiday|taking holiday|i am away|currently away|will be back|out of town|maternity leave|paternity leave|fuera de (la )?oficina|respuesta autom[aá]tica|me encuentro (fuera|de vacaciones)|estar[eé] fuera|ausente hasta|regreso el|absent du bureau|r[ée]ponse automatique|en cong[ée]|de retour le/i.test(
      haystack,
    )
  ) {
    return {
      intent: "auto_reply",
      urgency: "cold",
      sentiment: "neutral",
      reasoning: "Out-of-office phrase detected.",
    };
  }

  // 3) Explicit opt-out — always honoured.
  if (isExplicitOptOut(own) || isExplicitOptOut(subject)) {
    return {
      intent: "hard_no",
      urgency: "cold",
      sentiment: "negative",
      reasoning: "Explicit opt-out request.",
    };
  }

  // 4) Wrong person / forwarded.
  // Note: "please remove" is intentionally NOT in this set — it's almost
  // always part of "please remove me from your list", an opt-out (above).
  if (
    /not the right person|wrong person|please contact|forwarded to|cc:?ing|no soy la persona|no es (mi|el) [aá]rea|(contacte|contacta|contactar) a |(le|te) (reenv[ií]o|comparto)|lo reenv[ií]o|pas la bonne personne/i.test(
      haystack,
    )
  ) {
    return {
      intent: "wrong_person",
      urgency: "cold",
      sentiment: "neutral",
      reasoning: "Wrong-person/forward language detected.",
    };
  }

  // 5) Hard no (declined, not an opt-out instruction).
  if (
    /\bnot interested\b|\bno thanks\b|\bno thank you\b|\bwe'?re all set\b|\bwe are all set\b|(will not|won'?t|do not|don'?t) (require|need) your services|no (me|nos) interesa|no (estoy|estamos) interesad|no,? gracias|no (requerimos|necesitamos) (sus|tus|de sus|de tus) servicios|pas int[ée]ress[ée]|non merci/i.test(
      haystack,
    )
  ) {
    return {
      intent: "hard_no",
      urgency: "cold",
      sentiment: "negative",
      reasoning: "Not-interested language detected.",
    };
  }

  // 6) Wants meeting (high signal — specific phrases).
  const meetingHits = [
    /\b(let'?s|let us)\s+(chat|meet|talk|connect)/i,
    /\b(book|schedule|set up)\s+(a|the)?\s*(call|meeting|chat|demo|time)/i,
    /calendly\.com|cal\.com\/|when (are|works|would|do you have)/i,
    /\b(happy|glad|love)\s+to\s+(jump|hop)\s+on/i,
    /(grab|find)\s+(a|some)\s+time/i,
    /\bagend(ar|emos|amos)\b|(podemos|podr[ií]amos) (hablar|platicar|vernos|reunirnos)|cu[aá]ndo (puedes|podemos|te queda)/i,
  ];
  if (meetingHits.some((re) => re.test(haystack))) {
    return {
      intent: "wants_meeting",
      urgency: "hot",
      sentiment: "positive",
      reasoning: "Meeting request language detected.",
    };
  }

  // 7) Wants info (curious, send more, send deck).
  const infoHits = [
    /\b(send|share)\s+(me|us|over)?\s+(more|details|info|deck|case stud(?:y|ies)|pricing)/i,
    /\b(curious|interested|tell me more|how does (it|this) work)/i,
    /\b(can you|could you)\s+(send|share|tell)/i,
    /\bme interesa|nos interesa|m[aá]s informaci[oó]n|(env[ií]a|env[ií]e|m[aá]nda|m[aá]nde)(me|nos)\b|cotizaci[oó]n|cu[aá]nto cuesta|\bprecios?\b/i,
  ];
  if (infoHits.some((re) => re.test(haystack))) {
    return {
      intent: "wants_info",
      urgency: "warm",
      sentiment: "positive",
      reasoning: "Info-request language detected.",
    };
  }

  // 8) Not now / try again later.
  const laterHits = [
    /not (right )?now|reach out (in|after|next)|circle back|try again (later|in)/i,
    /next (quarter|month|year)|after (q\d|the (holidays|new year|summer))/i,
    /maybe later|too early|too busy/i,
    /m[aá]s adelante|ahorita no|por (el momento|ahora) no|en este momento no|ahora no|el pr[oó]ximo (mes|a[nñ]o|trimestre)/i,
  ];
  if (laterHits.some((re) => re.test(haystack))) {
    return {
      intent: "not_now",
      urgency: "warm",
      sentiment: "neutral",
      reasoning: "Defer-to-later language detected.",
    };
  }

  // Default — leave for human review.
  return {
    intent: "unclassified",
    urgency: null,
    sentiment: null,
    reasoning: "No strong signal — left for human review.",
  };
}
