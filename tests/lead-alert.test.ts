/**
 * Lead alert (lib/replies/lead-alert.ts): formatter, ordering, [test] marking,
 * opt-out wording, verbatim ES text, clipping, and the one-alert-per-run
 * collector the reply poll uses.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  LEAD_TEXT_MAX_CHARS,
  LeadAlertCollector,
  clipText,
  formatLeadAlert,
  intentLabel,
  sortLeadItems,
  type LeadAlertItem,
  type LeadSender,
} from "../lib/replies/lead-alert.ts";
import type { NotificationMessage } from "../lib/notify/send.ts";

function item(over: Partial<LeadAlertItem> = {}): LeadAlertItem {
  return {
    company: "Bakery Co",
    fromEmail: "ana@bakery.ca",
    intent: "wants_meeting",
    language: "en",
    text: "Sure, let's talk Thursday.",
    draftWaiting: true,
    isTest: false,
    ...over,
  };
}

test("one reply: subject names company + intent; body has sender, language, draft, text, /inbox link", () => {
  const a = formatLeadAlert([item()]);
  assert.ok(a);
  assert.equal(a.subject, "Reply from Bakery Co: wants a meeting");
  assert.match(a.body, /From: ana@bakery\.ca/);
  assert.match(a.body, /Language: EN/);
  assert.match(a.body, /Draft reply waiting for review/);
  assert.match(a.body, /> Sure, let's talk Thursday\./);
  assert.match(a.body, /\/inbox$/);
});

test("several replies: '<n> new replies (<k> want a meeting)', one numbered line each", () => {
  const a = formatLeadAlert([
    item({ company: "A", intent: "not_now", draftWaiting: true }),
    item({ company: "B", intent: "wants_meeting" }),
    item({ company: "C", intent: "wants_meeting" }),
  ]);
  assert.ok(a);
  assert.equal(a.subject, "3 new replies (2 want a meeting)");
  assert.match(a.body, /^1\. B: wants a meeting/m);
  assert.match(a.body, /^2\. C: wants a meeting/m);
  assert.match(a.body, /^3\. A: not now/m);
});

test("ordering: wants_meeting, wants_info, then the rest in arrival order", () => {
  const sorted = sortLeadItems([
    item({ company: "1", intent: "unclassified" }),
    item({ company: "2", intent: "wants_info" }),
    item({ company: "3", intent: "hard_no" }),
    item({ company: "4", intent: "wants_meeting" }),
    item({ company: "5", intent: "wrong_person" }),
  ]);
  assert.deepEqual(sorted.map((i) => i.company), ["4", "2", "1", "3", "5"]);
});

test("a test address is still alerted, marked [test]", () => {
  const one = formatLeadAlert([item({ isTest: true })]);
  assert.ok(one);
  assert.match(one.subject, /^\[test\] Reply from Bakery Co/);
  assert.match(one.body, /wants a meeting \[test\]/);
  const many = formatLeadAlert([item({ isTest: true, company: "T" }), item({ company: "R" })]);
  assert.ok(many);
  assert.match(many.body, /^1\. T: wants a meeting \[test\]$/m);
  assert.match(many.body, /^2\. R: wants a meeting$/m);
});

test("opt-out wording, and a failed opt-out says so", () => {
  assert.equal(intentLabel("hard_no"), "opted out: removed automatically");
  assert.match(intentLabel("hard_no", true), /FAILED/);
  const a = formatLeadAlert([item({ intent: "hard_no", draftWaiting: false })]);
  assert.equal(a?.subject, "Reply from Bakery Co: opted out: removed automatically");
  assert.match(a?.body ?? "", /No draft/);
  assert.equal(intentLabel("wants_info"), "wants more info");
  assert.equal(intentLabel("wrong_person"), "wrong person");
  assert.equal(intentLabel("unclassified"), "unclear");
});

test("Spanish reply text is kept verbatim", () => {
  const es = "Hola, sí me interesa.\n¿Podemos agendar una llamada el jueves? Gracias — Ana";
  const a = formatLeadAlert([item({ language: "es", text: es })]);
  assert.ok(a);
  assert.match(a.body, /Language: ES/);
  for (const line of es.split("\n")) assert.ok(a.body.includes(`> ${line}`), line);
});

test("long text is clipped to ~600 chars with an ellipsis", () => {
  const long = "x".repeat(2000);
  const clipped = clipText(long);
  assert.equal(clipped.length, LEAD_TEXT_MAX_CHARS + 1);
  assert.ok(clipped.endsWith("…"));
  assert.equal(clipText("short"), "short");
  const a = formatLeadAlert([item({ text: long })]);
  assert.ok(a && !a.body.includes("x".repeat(LEAD_TEXT_MAX_CHARS + 1)));
});

test("bounces and auto-replies alone produce no alert", () => {
  assert.equal(formatLeadAlert([item({ intent: "bounced" }), item({ intent: "auto_reply" })]), null);
  assert.equal(formatLeadAlert([]), null);
});

function recordingSender() {
  const calls: NotificationMessage[] = [];
  const send: LeadSender = async (m) => {
    calls.push(m);
    return { sent: 3, failed: [] };
  };
  return { send, calls };
}

test("acceptance: a poll run storing wants_meeting + hard_no + a bounce → ONE lead alert with 2 lines", async () => {
  const leads = new LeadAlertCollector();
  const { send, calls } = recordingSender();
  leads.add("t1", send, item({ company: "Bakery Co", intent: "wants_meeting" }));
  leads.add("t1", send, item({ company: "Gym MX", intent: "hard_no", draftWaiting: false }));
  leads.add("t1", send, item({ company: "Dead Inc", intent: "bounced", draftWaiting: false }));
  assert.equal(leads.size, 2);
  const res = await leads.send();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.kind, "lead");
  assert.equal(calls[0]?.subject, "2 new replies (1 wants a meeting)");
  const lines = (calls[0]?.body ?? "").split("\n").filter((l) => /^\d+\. /.test(l));
  assert.deepEqual(lines, ["1. Bakery Co: wants a meeting", "2. Gym MX: opted out: removed automatically"]);
  assert.ok(!calls[0]?.body.includes("Dead Inc"));
  assert.deepEqual(res, { sent: 3, failed: [] });
});

test("collector: nothing stored → nothing sent", async () => {
  const leads = new LeadAlertCollector();
  const { send, calls } = recordingSender();
  leads.add("t1", send, item({ intent: "auto_reply" }));
  assert.equal(leads.size, 0);
  assert.deepEqual(await leads.send(), { sent: 0, failed: [] });
  assert.equal(calls.length, 0);
});

test("collector: one alert per tenant; a throwing sender is reported, never thrown", async () => {
  const leads = new LeadAlertCollector();
  const ok = recordingSender();
  const boom: LeadSender = async () => {
    throw new Error("gmail down");
  };
  leads.add("t1", ok.send, item());
  leads.add("t2", boom, item());
  const res = await leads.send();
  assert.equal(ok.calls.length, 1);
  assert.equal(res.sent, 3);
  assert.deepEqual(res.failed, ["tenant t2: gmail down"]);
});
