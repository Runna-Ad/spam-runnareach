/**
 * Wrong-person replies get a short thank-you draft (Pedro, 2026-11-09): which
 * replies are drafted, which threads the nudge leaves alone, the "forwarded"
 * check, the department-name guard, and the fallback thank-you text.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isDraftableIntent, nudgeSkipsIntent } from "../lib/replies/draftable.ts";
import {
  composeReplyDraftHeuristic,
  replyGreetingName,
  saysForwarded,
  type DraftComposerInput,
} from "../lib/replies/draft-composer.ts";

const DESLOGES =
  "Hello Henry,\r\n\r\nI have forwarded your message to our management team, for their review. Thank you!\r\n\r\nRegards,\r\n\r\nAdele Desloges\r\nReception & Administrative Assistant";

test("wrong_person is drafted; opt-outs, bounces and out-of-office are not", () => {
  assert.equal(isDraftableIntent("wrong_person"), true);
  for (const i of ["wants_meeting", "wants_info", "not_now", "unclassified"] as const) assert.equal(isDraftableIntent(i), true, i);
  for (const i of ["hard_no", "bounced", "auto_reply"] as const) assert.equal(isDraftableIntent(i), false, i);
  assert.equal(isDraftableIntent(null), false);
});

test("the nudge never chases a thank-you to the wrong person", () => {
  assert.equal(nudgeSkipsIntent("wrong_person"), true);
  assert.equal(nudgeSkipsIntent("wants_info"), false);
  assert.equal(nudgeSkipsIntent(null), false);
});

test("saysForwarded: passed-on wording in English and Spanish, not a redirect", () => {
  assert.equal(saysForwarded(DESLOGES), true);
  assert.equal(saysForwarded("I've passed this along to our owner."), true);
  assert.equal(saysForwarded("I transferred your email to Mark in operations."), true);
  assert.equal(saysForwarded("Le reenvié su correo a la dirección."), true);
  assert.equal(saysForwarded("Lo turné al área de marketing."), true);
  assert.equal(saysForwarded("I'm not the right person, please contact Maria at maria@example.com."), false);
  assert.equal(saysForwarded("Wrong person, sorry."), false);
  assert.equal(saysForwarded(null), false);
});

test("replyGreetingName: a person's first name, never a department or an address", () => {
  assert.equal(replyGreetingName("Adele Desloges"), "Adele");
  assert.equal(replyGreetingName('"María José"'), "María");
  assert.equal(replyGreetingName("Reception"), null);
  assert.equal(replyGreetingName("Recepción General"), null);
  assert.equal(replyGreetingName("Info Desk"), null);
  assert.equal(replyGreetingName("reception@desloges.ca"), null);
  assert.equal(replyGreetingName(""), null);
  assert.equal(replyGreetingName(null), null);
});

function input(over: Partial<DraftComposerInput>): DraftComposerInput {
  return {
    contactFirstName: null,
    companyName: "Desloges Law Group Professional Corporation",
    language: "en",
    intent: "wrong_person",
    replySubject: "RE: what I didn't see on desloges.ca",
    replyBody: DESLOGES,
    threadSubject: "what I didn't see on desloges.ca",
    originalPitchBody: null,
    whatTheyDo: null,
    painSummary: null,
    senderFirstName: "Henry",
    agencyName: "Runna Advertising",
    ...over,
  };
}

test("fallback thank-you: short, no pitch or call ask, never greets the company", () => {
  const d = composeReplyDraftHeuristic(input({}));
  assert.ok(d.body.startsWith("Hi there,\n\nThank you so much for passing this along"), d.body);
  assert.match(d.body, /Hope to hear from you or the team soon\./);
  assert.doesNotMatch(d.body, /call|meeting|minutes|Desloges Law/i);
  assert.ok(d.body.endsWith("Best,\nHenry\nRunna Advertising"));
  assert.equal(d.subject, "Re: what I didn't see on desloges.ca");

  assert.ok(composeReplyDraftHeuristic(input({ contactFirstName: "Adele" })).body.startsWith("Hi Adele,"));

  const redirect = composeReplyDraftHeuristic(input({ replyBody: "Not the right person, sorry." }));
  assert.match(redirect.body, /point me their way/);
  assert.doesNotMatch(redirect.body, /passing this along/);

  const es = composeReplyDraftHeuristic(input({ language: "es", replyBody: "Le reenvié su correo a la dirección." }));
  assert.ok(es.body.startsWith("Hola,\n\nMuchas gracias por hacerlo llegar"), es.body);
  for (const b of [d.body, redirect.body, es.body]) assert.doesNotMatch(b, /—/);
});

test("fallback for other intents still greets the company when no name is known", () => {
  const d = composeReplyDraftHeuristic(input({ intent: "wants_info", replyBody: "Tell me more" }));
  assert.ok(d.body.startsWith("Hi Desloges Law Group Professional Corporation,"));
});
