import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  checkMessageInbox,
  imapClientOptions,
  processIncomingWarmupEmails,
  type ImapClientFactory,
  type ImapClientLike,
  type ReplyResult,
} from "../lib/warmup/imap.ts";
import {
  PLACEMENT_CHECK_BUDGET_MS,
  PLACEMENT_CHECK_MAX_MS,
  runPlacementChecks,
  type PlacementCheckDeps,
} from "../lib/warmup/intelligence.ts";
import type { WarmupBuddy, WarmupLogEntry } from "../lib/warmup/types.ts";

// ── Fake ImapFlow ──────────────────────────────────────────────────────────────
// Behaves like imapflow 1.3.3 when the socket dies: emits 'error' on a later
// tick (an EventEmitter with no 'error' listener throws → uncaughtException),
// rejects the command in flight with "Connection not available", and every
// later command fails the same way.

type Step = "connect" | "mailboxOpen" | "search" | "messageMove" | "fetchOne" | "messageFlagsAdd" | "logout";

function noConnection(): Error {
  return Object.assign(new Error("Connection not available"), { code: "NoConnection" });
}

class FakeImap extends EventEmitter implements ImapClientLike {
  dead = false;
  opened = "";
  calls: string[] = [];
  private hang: (() => void) | null = null;
  private failAt: Step | null;
  private folders: Record<string, number[]>;
  private opts: { hangAt?: Step; failOnCall?: number };
  constructor(failAt: Step | null, folders: Record<string, number[]>, opts: { hangAt?: Step; failOnCall?: number } = {}) {
    super();
    this.failAt = failAt;
    this.folders = folders;
    this.opts = opts;
  }
  private async step<T>(name: Step, value: () => T): Promise<T> {
    this.calls.push(name);
    if (this.dead) throw noConnection();
    if (this.opts.hangAt === name) {
      await new Promise<void>((_, reject) => { this.hang = () => reject(noConnection()); });
    }
    if (this.failAt === name && this.calls.filter((c) => c === name).length >= (this.opts.failOnCall ?? 1)) {
      this.dead = true;
      setImmediate(() => this.emit("error", Object.assign(new Error("Socket timeout"), { code: "ETIMEOUT" })));
      throw noConnection();
    }
    return value();
  }
  connect() { return this.step("connect", () => undefined); }
  mailboxOpen(path: string) {
    return this.step("mailboxOpen", () => {
      if (!(path in this.folders)) throw new Error(`Mailbox doesn't exist: ${path}`);
      this.opened = path;
      return {};
    });
  }
  search() { return this.step("search", () => this.folders[this.opened] ?? []); }
  messageMove() { return this.step("messageMove", () => true); }
  fetchOne(range: string) {
    return this.step("fetchOne", () => ({ envelope: { subject: `subject ${range}`, messageId: `m${range}@x.com` } }));
  }
  messageFlagsAdd() { return this.step("messageFlagsAdd", () => true); }
  logout() { return this.step("logout", () => { this.dead = true; }); }
  close() {
    this.dead = true;
    this.hang?.();
  }
}

process.env.TEST_BUDDY_EMAIL = "buddy@gmail.com";
process.env.TEST_BUDDY_PASS = "app-password";
const buddy: WarmupBuddy = {
  id: "b1",
  email: "buddy@gmail.com",
  display_name: "Buddy",
  app_password_secret: "TEST_BUDDY_PASS",
  email_env_var: "TEST_BUDDY_EMAIL",
  imap_host: "imap.gmail.com",
  imap_port: 993,
  is_active: true,
  last_used_at: null,
};

/** Runs `fn`, waits for late events, returns the process-level failures seen. */
async function captureProcessFailures(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const onUncaught = (err: Error) => { seen.push(`uncaughtException: ${err.message}`); };
  const onUnhandled = (err: unknown) => { seen.push(`unhandledRejection: ${String(err)}`); };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  try {
    await fn();
    // Late 'error' emits and rejections land on later ticks.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
}

function factoryFor(clients: FakeImap[], make: () => FakeImap): ImapClientFactory {
  return () => {
    const c = make();
    clients.push(c);
    return c;
  };
}

// Spam-placed message: reaches every step of a check including the rescue move.
const SPAM_FOLDERS = { INBOX: [], "[Gmail]/Spam": [7] };

const checkCases: Array<{ step: Step; expected: null | "spam" }> = [
  { step: "connect", expected: null },
  { step: "mailboxOpen", expected: null },
  { step: "search", expected: null },
  // Seen in spam, then the rescue move dies: still a spam placement.
  { step: "messageMove", expected: "spam" },
  // Result was already decided; only the goodbye failed.
  { step: "logout", expected: "spam" },
];

for (const { step, expected } of checkCases) {
  test(`checkMessageInbox: connection dies at ${step} → ${expected ?? "null"}, nothing escapes to the process`, async () => {
    const clients: FakeImap[] = [];
    let result: Awaited<ReturnType<typeof checkMessageInbox>> | undefined;
    const failures = await captureProcessFailures(async () => {
      result = await checkMessageInbox(buddy, "abc@mail.gmail.com", {
        makeClient: factoryFor(clients, () => new FakeImap(step, SPAM_FOLDERS)),
      });
    });
    assert.deepEqual(failures, []);
    if (expected === null) assert.equal(result, null);
    else assert.equal(result?.foundInSpam, true);
    assert.ok(clients.every((c) => c.listenerCount("error") > 0));
  });
}

test("checkMessageInbox: a dead connection stops the folder walk (no 'folder missing' guesses)", async () => {
  const clients: FakeImap[] = [];
  await checkMessageInbox(buddy, "abc@mail.gmail.com", {
    makeClient: factoryFor(clients, () =>
      new FakeImap("search", { INBOX: [], "[Gmail]/Category Promotions": [], "[Gmail]/Spam": [7] }, { failOnCall: 2 })),
  });
  // Dies on the Promotions search: straight to logout, no walk over the
  // remaining folders (each would fail and read as "folder missing").
  assert.deepEqual(clients[0]?.calls, ["connect", "mailboxOpen", "search", "mailboxOpen", "search", "logout"]);
});

test("checkMessageInbox: a hung command is cut off at timeoutMs and the row stays pending", async () => {
  const clients: FakeImap[] = [];
  const started = Date.now();
  const result = await checkMessageInbox(buddy, "abc@mail.gmail.com", {
    timeoutMs: 50,
    makeClient: factoryFor(clients, () => new FakeImap(null, SPAM_FOLDERS, { hangAt: "search" })),
  });
  assert.equal(result, null);
  assert.ok(Date.now() - started < 1_000);
});

test("checkMessageInbox: English All Mail counts as delivered and is never moved out of", async () => {
  const clients: FakeImap[] = [];
  const result = await checkMessageInbox(buddy, "abc@mail.gmail.com", {
    makeClient: factoryFor(clients, () => new FakeImap(null, { INBOX: [], "[Gmail]/All Mail": [3] })),
  });
  assert.equal(result?.foundInInbox, true);
  assert.equal(clients[0]?.calls.includes("messageMove"), false);
});

test("imapClientOptions: no auto-IDLE, no logger", () => {
  const o = imapClientOptions("imap.gmail.com", 993, "a@b.com", "pw");
  assert.equal(o.disableAutoIdle, true);
  assert.equal(o.logger, false);
});

// ── processIncomingWarmupEmails ────────────────────────────────────────────────

const INCOMING = { INBOX: [11] };
const templates = [{ subject: "Re:", reply_text: "Thanks!" }];

const incomingCases: Array<{ step: Step | "smtp"; expected: number }> = [
  { step: "connect", expected: 0 },
  { step: "mailboxOpen", expected: 0 },
  { step: "search", expected: 0 },
  { step: "fetchOne", expected: 0 },
  // The reply went out; only marking it read failed.
  { step: "messageFlagsAdd", expected: 1 },
  { step: "logout", expected: 1 },
  { step: "smtp", expected: 0 },
];

for (const { step, expected } of incomingCases) {
  test(`processIncomingWarmupEmails: connection dies at ${step} → ${expected}, nothing escapes to the process`, async () => {
    const clients: FakeImap[] = [];
    let replied = -1;
    const failures = await captureProcessFailures(async () => {
      replied = await processIncomingWarmupEmails(buddy, "warm@runna.ca", templates, {
        makeClient: factoryFor(clients, () => new FakeImap(step === "smtp" ? null : step, INCOMING)),
        sendReply: async (_b, inReplyTo): Promise<ReplyResult> => {
          if (step === "smtp") {
            // A late socket timeout on the (already closed) IMAP client while
            // the SMTP send is in flight, then the send itself fails.
            clients[0]?.emit("error", Object.assign(new Error("Socket timeout"), { code: "ETIMEOUT" }));
            throw noConnection();
          }
          return { sent: true, inReplyToMessageId: inReplyTo };
        },
      });
    });
    assert.deepEqual(failures, []);
    assert.equal(replied, expected);
    assert.ok(clients.every((c) => c.listenerCount("error") > 0));
  });
}

test("processIncomingWarmupEmails: no IMAP connection is open while the SMTP reply is sent", async () => {
  const clients: FakeImap[] = [];
  let openDuringSend = -1;
  const replied = await processIncomingWarmupEmails(buddy, "warm@runna.ca", templates, {
    makeClient: factoryFor(clients, () => new FakeImap(null, INCOMING)),
    sendReply: async (_b, inReplyTo) => {
      openDuringSend = clients.filter((c) => !c.dead).length;
      return { sent: true, inReplyToMessageId: inReplyTo };
    },
  });
  assert.equal(replied, 1);
  assert.equal(openDuringSend, 0);
  // The reconnect marks the reply read.
  assert.ok(clients[1]?.calls.includes("messageFlagsAdd"));
});

// ── Placement checks: time budget ──────────────────────────────────────────────

const HOUR = 3_600_000;
function pendingRow(i: number, buddyId = "b1"): WarmupLogEntry {
  return {
    id: `row${i}`,
    tenant_id: "t",
    config_id: "c",
    buddy_id: buddyId,
    direction: "sent",
    subject: "s",
    message_id: `m${i}@mail.gmail.com`,
    thread_id: null,
    landed_in_inbox: null,
    reply_sent: false,
    day_number: 1,
    created_at: new Date(Date.UTC(2026, 9, 17) + i * HOUR).toISOString(),
  };
}

type FakeBuddy = { id: string };
function placementDeps(checkMs: number, outcome: { foundInInbox: boolean; foundInSpam: boolean } | null = { foundInInbox: true, foundInSpam: false }) {
  let clock = 0;
  const checkedIds: string[] = [];
  const timeouts: number[] = [];
  const recorded: Array<[string, boolean]> = [];
  const deps: PlacementCheckDeps<FakeBuddy> = {
    buddies: [{ id: "b1" }],
    buddyId: (b) => b.id,
    now: () => clock,
    resolveRfcId: async (log) => log.message_id,
    check: async (_b, rfc, timeoutMs) => {
      checkedIds.push(rfc);
      timeouts.push(timeoutMs);
      clock += Math.min(checkMs, timeoutMs);
      return outcome;
    },
    record: async (id, landed) => { recorded.push([id, landed]); },
  };
  return { deps, checkedIds, timeouts, recorded, clock: () => clock };
}

test("placement: 6 pending, slow checks → oldest first within the budget, checks end in time for the sends", async () => {
  const f = placementDeps(12_000);
  const rows = [0, 1, 2, 3, 4, 5].map((i) => pendingRow(i)).reverse(); // query order irrelevant
  const report = await runPlacementChecks(rows, PLACEMENT_CHECK_BUDGET_MS, f.deps);
  // Starts at 0, 12, 24, 36s; none after 40s.
  assert.deepEqual(f.checkedIds, ["m0@mail.gmail.com", "m1@mail.gmail.com", "m2@mail.gmail.com", "m3@mail.gmail.com"]);
  assert.equal(report.checked, 4);
  assert.equal(report.deferred, 2);
  // The send step still has its time: checks end by budget + one capped check,
  // and that leaves 45s before the 105s send deadline.
  assert.ok(f.clock() <= PLACEMENT_CHECK_BUDGET_MS + PLACEMENT_CHECK_MAX_MS);
  assert.ok(f.timeouts.every((t) => t === PLACEMENT_CHECK_MAX_MS));
  assert.ok(PLACEMENT_CHECK_BUDGET_MS + PLACEMENT_CHECK_MAX_MS <= 105_000 - 45_000);
});

test("placement: fast checks → every pending send is checked (no count cap)", async () => {
  const f = placementDeps(1_000);
  const report = await runPlacementChecks([0, 1, 2, 3, 4, 5].map((i) => pendingRow(i)), PLACEMENT_CHECK_BUDGET_MS, f.deps);
  assert.equal(report.checked, 6);
  assert.equal(f.recorded.length, 6);
});

test("placement: an inactive buddy's row is skipped without using budget", async () => {
  const f = placementDeps(1_000);
  const rows = [pendingRow(0, "inactive"), ...[1, 2, 3, 4, 5].map((i) => pendingRow(i))];
  const report = await runPlacementChecks(rows, PLACEMENT_CHECK_BUDGET_MS, f.deps);
  assert.equal(report.skipped, 1);
  assert.equal(report.checked, 5);
  assert.equal(f.checkedIds.includes("m0@mail.gmail.com"), false);
});

test("placement: a row with no searchable id is skipped", async () => {
  const f = placementDeps(1_000);
  f.deps.resolveRfcId = async (log) => (log.id === "row0" ? null : log.message_id);
  const report = await runPlacementChecks([0, 1].map((i) => pendingRow(i)), PLACEMENT_CHECK_BUDGET_MS, f.deps);
  assert.deepEqual(report, { checked: 1, not_found: 0, skipped: 1, deferred: 0 });
});

test("placement: not found stays null (never written), spam is written false", async () => {
  const notFound = placementDeps(1_000, null);
  const r1 = await runPlacementChecks([pendingRow(0)], PLACEMENT_CHECK_BUDGET_MS, notFound.deps);
  assert.equal(r1.not_found, 1);
  assert.deepEqual(notFound.recorded, []);

  const nowhere = placementDeps(1_000, { foundInInbox: false, foundInSpam: false });
  await runPlacementChecks([pendingRow(0)], PLACEMENT_CHECK_BUDGET_MS, nowhere.deps);
  assert.deepEqual(nowhere.recorded, []);

  const spam = placementDeps(1_000, { foundInInbox: false, foundInSpam: true });
  await runPlacementChecks([pendingRow(0)], PLACEMENT_CHECK_BUDGET_MS, spam.deps);
  assert.deepEqual(spam.recorded, [["row0", false]]);
});
