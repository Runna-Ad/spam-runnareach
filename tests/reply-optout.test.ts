/**
 * Reply handling that decides whether we ever email someone again:
 * quoted-text stripping, explicit opt-out detection (EN/ES/FR), temporary
 * delivery delays vs bounces. Fixtures marked "real" are replies S.P.A.M.
 * actually received (Jun–Aug 2026), trimmed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyReplyHeuristic,
  isExplicitOptOut,
  isTemporaryDeliveryDelay,
  stripQuotedReply,
} from "../lib/replies/classify.ts";

const FOOTER_QUOTE =
  "> Rünna · 123 Main St SW, Calgary, AB\r\n> To stop receiving these emails: https://spam-runnareach.vercel.app/api/unsubscribe?t=abc.def";

const classify = (body: string, subject = "Re: hello", from = "owner@acme.ca") =>
  classifyReplyHeuristic({ subject, body_text: body, from_email: from });

test("real GYMVMT reply: interest above a Gmail quote stays wants_info", () => {
  const body =
    "Hey did the audit and interested in knowing more about the option that said an automated trial-to-member nurture system\r\n" +
    "On 22 Jun 2026 at 2:27:29 PM -0600, pedro@runnareach.com, wrote:\r\n> GYMVMT: inquiries dying between locations\r\n" +
    FOOTER_QUOTE;
  assert.equal(stripQuotedReply(body).includes("unsubscribe"), false);
  assert.equal(classify(body).intent, "wants_info");
});

test("quoted unsubscribe footer never turns a positive reply into an opt-out", () => {
  const body = `Yes, let's chat next week.\r\n\r\nOn Mon, Oct 19, 2026 at 9:00 AM Pedro <pedro@runnareach.com> wrote:\r\n> Hi Maria,\r\n${FOOTER_QUOTE}`;
  assert.equal(isExplicitOptOut(stripQuotedReply(body)), false);
  assert.equal(classify(body).intent, "wants_meeting");
});

test("Gmail attribution wrapped over two lines is still cut (real Acadian layout)", () => {
  const body =
    "you sir are a time\r\nwaster!!!!\r\n\r\nOn Sat, Jul 11, 2026 at 9:51 AM Pedro De Velasco <pedro@runnareach.com>\r\nwrote:\r\n\r\n> Hi Calgauthier,\r\n" +
    FOOTER_QUOTE;
  assert.equal(stripQuotedReply(body), "you sir are a time\nwaster!!!!");
});

test("real High Caliber reply (Outlook header block) is a hard no, not an opt-out instruction", () => {
  const body =
    "Thank you for your offering, but we will not require your services.\r\n\r\nLeanne Mein | Marketing Manager\r\n\r\n" +
    "From: Pedro De Velasco <pedro@runnareach.com>\r\nSent: July 23, 2026 10:25 AM\r\nTo: Info <info@highcaliberproducts.com>\r\nSubject: Re: high caliber\r\n\r\nHi High Caliber team, unsubscribe here: https://x/api/unsubscribe";
  const own = stripQuotedReply(body);
  assert.ok(!own.includes("From:"), "Outlook quote removed");
  assert.equal(isExplicitOptOut(own), false);
  assert.equal(classify(body).intent, "hard_no");
});

test("real Rocky Mountain reply reads as not now", () => {
  const body =
    "Hi Pedro,\r\n\r\nThanks for reaching out again. We're currently focused on our existing internal processes and aren't looking to add any new intake tools at this time. Maybe later.\r\n\r\nBest,\r\nRob";
  assert.equal(classify(body).intent, "not_now");
});

test("explicit opt-outs in English, Spanish and French", () => {
  for (const text of [
    "Please unsubscribe me.",
    "Take me off your list",
    "Stop emailing us",
    "BAJA",
    "Baja.",
    "Favor de darme de baja de su lista",
    "Por favor dénme de baja",
    "No me vuelvan a escribir",
    "Dejen de enviar correos por favor",
    "Sáquenme de su lista",
    "Merci de me désabonner",
    "Je ne veux plus recevoir ces messages, retirez-moi",
  ]) {
    assert.ok(isExplicitOptOut(text), text);
    assert.equal(classify(text).intent, "hard_no", text);
  }
});

test("Spanish/French declines and look-alikes", () => {
  assert.equal(classify("Gracias, pero no nos interesa por ahora.").intent, "hard_no");
  assert.equal(classify("Non merci.").intent, "hard_no");
  // "baja" inside a normal sentence is not an instruction.
  assert.equal(isExplicitOptOut("En temporada baja tenemos menos reservaciones, me interesa saber más"), false);
  assert.equal(classify("En temporada baja tenemos menos reservaciones, me interesa saber más").intent, "wants_info");
  // "me interesa" vs "no me interesa"
  assert.equal(classify("Sí, me interesa. ¿Me mandas la cotización?").intent, "wants_info");
});

test("Spanish and French out-of-office", () => {
  assert.equal(classify("Respuesta automática: me encuentro fuera de la oficina hasta el lunes.").intent, "auto_reply");
  assert.equal(classify("Je suis absent du bureau, de retour le 3 novembre.").intent, "auto_reply");
});

test("real 'Delivery incomplete' notice is a delay, not a bounce", () => {
  const input = {
    subject: "Delivery Status Notification (Delay)",
    body_text:
      "** Delivery incomplete ** There was a temporary problem delivering your message to atencion@abogadosenguadalajara.com. Gmail will retry for 45 more hours. You'll be notified if the delivery fails permanently.",
    from_email: "mailer-daemon@googlemail.com",
  };
  assert.equal(isTemporaryDeliveryDelay(input), true);
  assert.notEqual(classifyReplyHeuristic(input).intent, "bounced");
});

test("real permanent bounce is still a bounce", () => {
  const input = {
    subject: "Delivery Status Notification (Failure)",
    body_text:
      "** Address not found ** Your message wasn't delivered to info@woodbinehotels.com because the address couldn't be found, or is unable to receive mail.",
    from_email: "mailer-daemon@googlemail.com",
  };
  assert.equal(isTemporaryDeliveryDelay(input), false);
  assert.equal(classifyReplyHeuristic(input).intent, "bounced");
});
