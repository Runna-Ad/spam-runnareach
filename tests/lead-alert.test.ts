/**
 * Lead alert (lib/replies/lead-alert.ts): formatter, ordering, [test] marking,
 * opt-out wording, verbatim ES text, clipping, and the durable send the reply
 * poll runs (claim on replies.hot_alert_sent_at, release on total failure).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  LEAD_TEXT_MAX_CHARS,
  clipText,
  formatLeadAlert,
  intentLabel,
  leadItemFromRow,
  sendPendingLeadAlerts,
  sortLeadItems,
  supabaseLeadAlertStore,
  type LeadAlertItem,
  type LeadAlertStore,
  type LeadReplyRow,
  type TenantLeadSender,
} from "../lib/replies/lead-alert.ts";
import { isTestAddress } from "../lib/compliance/test-addresses.ts";
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
  assert.match(a.body, /Prospect language: EN/);
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

test("test replies: marked [test], never counted as wanting a meeting; an all-test run says [test] in the subject", () => {
  const mixed = formatLeadAlert([item({ isTest: true }), item({ company: "R" })]);
  assert.equal(mixed?.subject, "2 new replies (1 wants a meeting)");
  const allTest = formatLeadAlert([item({ isTest: true }), item({ isTest: true, intent: "wants_info" })]);
  assert.equal(allTest?.subject, "[test] 2 new replies (0 want a meeting)");
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
  assert.match(intentLabel("hard_no", true), /NOT confirmed/);
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
  assert.match(a.body, /Prospect language: ES/);
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

// ── Durable send ─────────────────────────────────────────────────────────────

type Row = LeadReplyRow & { received_at: string; hot_alert_sent_at: string | null };

/** Same semantics as the replies table: claim only where still null. */
function memoryStore(rows: Row[]): LeadAlertStore & { rows: Row[] } {
  return {
    rows,
    async pending(sinceIso) {
      return rows
        .filter((r) => r.hot_alert_sent_at === null && r.intent !== "bounced" && r.intent !== "auto_reply" && r.received_at >= sinceIso)
        .map((r) => ({ id: r.id, tenantId: r.tenant_id, item: leadItemFromRow(r, isTestAddress) }));
    },
    async claim(ids) {
      const won: string[] = [];
      for (const r of rows) {
        if (ids.includes(r.id) && r.hot_alert_sent_at === null) {
          r.hot_alert_sent_at = "now";
          won.push(r.id);
        }
      }
      return won;
    },
    async release(ids) {
      for (const r of rows) if (ids.includes(r.id)) r.hot_alert_sent_at = null;
    },
  };
}

const NOW = new Date("2026-10-18T12:00:00Z");

function row(id: string, intent: Row["intent"], over: Partial<Row> = {}): Row {
  return {
    id,
    tenant_id: "t1",
    from_email: `${id}@prospect.ca`,
    intent,
    body_text: `Reply ${id}\n\nOn Mon, Oct 12, Henry wrote:\n> our pitch`,
    draft_status: intent === "wants_meeting" ? "pending" : null,
    prospects: { company_name: `Co ${id}`, language: "en", status: intent === "hard_no" ? "suppressed" : "replied" },
    received_at: "2026-10-18T11:00:00.000Z",
    hot_alert_sent_at: null,
    ...over,
  };
}

function recordingSend(result: (n: number) => { sent: number; failed: string[] } | Error) {
  const calls: Array<{ tenantId: string; message: NotificationMessage }> = [];
  const send: TenantLeadSender = async (tenantId, message) => {
    calls.push({ tenantId, message });
    const r = result(calls.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { send, calls };
}

const delivered = () => ({ sent: 3, failed: [] });

test("acceptance: wants_meeting + hard_no + a bounce stored → ONE lead alert with 2 lines, kind lead", async () => {
  const store = memoryStore([row("a", "wants_meeting"), row("b", "hard_no"), row("c", "bounced")]);
  const { send, calls } = recordingSend(delivered);
  const res = await sendPendingLeadAlerts(store, send, NOW);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.message.kind, "lead");
  assert.equal(calls[0]?.message.subject, "2 new replies (1 wants a meeting)");
  const lines = (calls[0]?.message.body ?? "").split("\n").filter((l) => /^\d+\. /.test(l));
  assert.deepEqual(lines, ["1. Co a: wants a meeting", "2. Co b: opted out: removed automatically"]);
  assert.match(calls[0]?.message.body ?? "", /> Reply a/);
  assert.ok(!(calls[0]?.message.body ?? "").includes("our pitch"), "quoted thread stripped");
  assert.ok(!(calls[0]?.message.body ?? "").includes("Co c"));
  assert.deepEqual(res, { sent: 3, failed: [] });
  assert.deepEqual(store.rows.map((r) => r.hot_alert_sent_at !== null), [true, true, false]);
});

test("B1: send fails in run 1 → nothing marked; run 2 alerts it exactly once; run 3 sends nothing", async () => {
  const store = memoryStore([row("a", "wants_meeting")]);
  const { send, calls } = recordingSend((n) => (n === 1 ? { sent: 0, failed: ["x: 503"] } : delivered()));
  const r1 = await sendPendingLeadAlerts(store, send, NOW);
  assert.deepEqual(r1, { sent: 0, failed: ["x: 503"] });
  assert.equal(store.rows[0]?.hot_alert_sent_at, null);
  const r2 = await sendPendingLeadAlerts(store, send, NOW);
  assert.equal(r2.sent, 3);
  assert.equal(calls.length, 2);
  const r3 = await sendPendingLeadAlerts(store, send, NOW);
  assert.deepEqual(r3, { sent: 0, failed: [] });
  assert.equal(calls.length, 2);
});

test("a throwing sender releases the claim and is reported, never thrown", async () => {
  const store = memoryStore([row("a", "not_now")]);
  const { send } = recordingSend(() => new Error("gmail down"));
  const res = await sendPendingLeadAlerts(store, send, NOW);
  assert.deepEqual(res, { sent: 0, failed: ["tenant t1: gmail down"] });
  assert.equal(store.rows[0]?.hot_alert_sent_at, null);
});

test("partial delivery keeps the claim: no duplicate to those who got it", async () => {
  const store = memoryStore([row("a", "wants_info")]);
  const { send, calls } = recordingSend(() => ({ sent: 2, failed: ["nila@runna.com.mx: 500"] }));
  await sendPendingLeadAlerts(store, send, NOW);
  await sendPendingLeadAlerts(store, send, NOW);
  assert.equal(calls.length, 1);
});

test("a run killed before sending: the unclaimed reply is alerted by the next run", async () => {
  // Run 1 inserted the row and died before step 5: nothing claimed.
  const store = memoryStore([row("a", "wants_meeting")]);
  const { send, calls } = recordingSend(delivered);
  await sendPendingLeadAlerts(store, send, NOW);
  assert.equal(calls.length, 1);
});

test("replies older than 48h, bounces and out-of-office are never alerted; nothing pending → nothing sent", async () => {
  const store = memoryStore([
    row("old", "wants_meeting", { received_at: "2026-08-01T00:00:00.000Z" }),
    row("b", "bounced"),
    row("o", "auto_reply"),
  ]);
  const { send, calls } = recordingSend(delivered);
  assert.deepEqual(await sendPendingLeadAlerts(store, send, NOW), { sent: 0, failed: [] });
  assert.equal(calls.length, 0);
});

test("one alert per tenant, each claimed separately", async () => {
  const store = memoryStore([row("a", "wants_meeting"), row("b", "not_now", { tenant_id: "t2" })]);
  const { send, calls } = recordingSend(delivered);
  await sendPendingLeadAlerts(store, send, NOW);
  assert.deepEqual(calls.map((c) => c.tenantId).sort(), ["t1", "t2"]);
});

test("a concurrent run that already claimed a row: it is not sent twice", async () => {
  const store = memoryStore([row("a", "wants_meeting"), row("b", "wants_info")]);
  const racing: LeadAlertStore = {
    ...store,
    async claim(ids) {
      store.rows[0]!.hot_alert_sent_at = "other run";
      return store.claim(ids);
    },
  };
  const { send, calls } = recordingSend(delivered);
  await sendPendingLeadAlerts(racing, send, NOW);
  assert.equal(calls[0]?.message.subject, "Reply from Co b: wants more info");
});

test("leadItemFromRow: draft pending → waiting; hard_no on a non-suppressed prospect → removal not confirmed; test address", () => {
  const optOut = leadItemFromRow(row("a", "hard_no", { prospects: { company_name: "Gym", language: "es", status: "replied" } }), isTestAddress);
  assert.equal(optOut.optOutFailed, true);
  assert.equal(optOut.language, "es");
  assert.equal(leadItemFromRow(row("b", "hard_no"), isTestAddress).optOutFailed, false);
  assert.equal(leadItemFromRow(row("c", "wants_meeting"), isTestAddress).draftWaiting, true);
  assert.equal(leadItemFromRow(row("d", "wants_meeting", { from_email: "pedrojr22+x@gmail.com" }), isTestAddress).isTest, true);
  assert.equal(leadItemFromRow(row("e", "wants_info", { prospects: null }), isTestAddress).company, "e@prospect.ca");
});

// ── supabaseLeadAlertStore against a recording fake client ──────────────────

type Call = { table: string; ops: Array<[string, unknown[]]> };

function recordingDb(answer: (call: Call) => { data: unknown; error: { message: string } | null }) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      from(table: string) {
        const call: Call = { table, ops: [] };
        calls.push(call);
        const b: Record<string, unknown> = {};
        for (const m of ["select", "update", "eq", "in", "is", "not", "gte", "order", "limit"]) {
          b[m] = (...args: unknown[]) => (call.ops.push([m, args]), b);
        }
        b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(answer(call)).then(resolve, reject);
        return b;
      },
    },
  };
}

const op = (c: Call | undefined, name: string) => c?.ops.find(([o]) => o === name)?.[1];

test("store.pending: unalerted, human intents, received since the cutoff", async () => {
  const db = recordingDb(() => ({ data: [], error: null }));
  await supabaseLeadAlertStore(db.client, isTestAddress).pending("2026-10-16T12:00:00.000Z");
  const c = db.calls[0];
  assert.equal(c?.table, "replies");
  assert.deepEqual(op(c, "is"), ["hot_alert_sent_at", null]);
  assert.deepEqual(op(c, "not"), ["intent", "in", "(bounced,auto_reply)"]);
  assert.deepEqual(op(c, "gte"), ["received_at", "2026-10-16T12:00:00.000Z"]);
});

test("store.claim only sets rows still null and returns the ids won; release clears; errors throw", async () => {
  const db = recordingDb((call) => ({ data: op(call, "update") && op(call, "is") ? [{ id: "a" }] : null, error: null }));
  const store = supabaseLeadAlertStore(db.client, isTestAddress);
  assert.deepEqual(await store.claim(["a", "b"]), ["a"]);
  assert.deepEqual(op(db.calls[0], "is"), ["hot_alert_sent_at", null]);
  assert.deepEqual(op(db.calls[0], "in"), ["id", ["a", "b"]]);
  await store.release(["a"]);
  assert.deepEqual(op(db.calls[1], "update"), [{ hot_alert_sent_at: null }]);
  assert.deepEqual(await store.claim([]), []);
  assert.equal(db.calls.length, 2);

  const failing = supabaseLeadAlertStore(recordingDb(() => ({ data: null, error: { message: "down" } })).client, isTestAddress);
  await assert.rejects(failing.pending("x"), /lead alert lookup failed: down/);
  await assert.rejects(failing.claim(["a"]), /claim failed/);
});
