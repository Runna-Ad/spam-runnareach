import assert from "node:assert/strict";
import test from "node:test";
import { fetchExemplars, onDnc } from "../lib/pitches/exemplar-queries.ts";
import type { ExemplarTarget } from "../lib/pitches/exemplars.ts";

// fetchExemplars against a fake client: a prospect that opted out (suppressed
// since, or its address / domain on the do-not-contact list) is never anyone's
// example, even when its own unsubscribe event is missing.

const NOW = new Date("2026-10-17T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const TARGET: ExemplarTarget = { segment: { industry: "legal", market: "ca", size: "small" }, lang: "en", prospect_id: "p-target" };

type Row = Record<string, unknown>;

/** Chainable PostgREST stand-in: applies eq/in filters to the table's rows, ignores the rest. */
class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private rows: Row[];
  private fail: boolean;
  constructor(rows: Row[], fail: boolean) {
    this.rows = rows;
    this.fail = fail;
  }
  select() { return this; }
  is() { return this; }
  lte() { return this; }
  order() { return this; }
  limit() { return this; }
  abortSignal() { return this; }
  returns() { return this; }
  eq(col: string, v: unknown) {
    if (!col.includes(".")) this.filters.push((r) => r[col] === v);
    return this;
  }
  in(col: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[col]));
    return this;
  }
  then<T>(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => T) {
    if (this.fail) return Promise.resolve(resolve({ data: null, error: { message: "boom" } }));
    return Promise.resolve(resolve({ data: this.rows.filter((r) => this.filters.every((f) => f(r))), error: null }));
  }
}

function fakeClient(tables: { candidates: Row[]; events: Row[]; texts: Row[]; dnc: Row[] }, opts: { dncFails?: boolean } = {}) {
  let pitchReads = 0;
  return {
    from(table: string) {
      if (table === "pitches") return new Query(pitchReads++ === 0 ? tables.candidates : tables.texts, false);
      if (table === "pitch_events") return new Query(tables.events, false);
      if (table === "do_not_contact_list") return new Query(tables.dnc, opts.dncFails ?? false);
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function world() {
  const people = [
    { id: "a", status: "booked", email: "owner@firm-a.ca" },
    { id: "b", status: "suppressed", email: "owner@firm-b.ca" },
    { id: "c", status: "sent", email: "Owner@Firm-C.ca" },
    { id: "d", status: "sent", email: "owner@firm-d.ca" },
    { id: "e", status: "replied", email: "owner@firm-e.ca" },
  ];
  const candidates = people.map((p, i) => ({
    id: `pitch-${p.id}`,
    tenant_id: "t1",
    prospect_id: `prospect-${p.id}`,
    parent_pitch_id: null,
    status: "sent",
    sent_at: daysAgo(30 + i),
    critic_pass: true,
    gate_override: null,
    prospects: { industry: "Law firm", market: "CA", language: "en", status: p.status },
    prospect_contacts: { email: p.email },
  }));
  const events = people.flatMap((p, i) => [
    { tenant_id: "t1", pitch_id: `pitch-${p.id}`, event_type: "sent", event_at: daysAgo(30 + i), payload: null },
    { tenant_id: "t1", pitch_id: `pitch-${p.id}`, event_type: "reply", event_at: daysAgo(28 + i), payload: { intent: "wants_meeting" } },
  ]);
  const texts = people.map((p) => ({
    id: `pitch-${p.id}`,
    tenant_id: "t1",
    subject: "evening calls",
    body_original: "Hi there,\n\nMost law firms miss calls after six, and the people who call are ready to hire.\n\nHenry\nRunna Advertising",
    body_edited: null,
    prospects: { company_name: `Firm ${p.id.toUpperCase()}`, domain: `firm-${p.id}.ca`, website_url: null, city: null },
    prospect_contacts: { full_name: "Ana Ruiz", email: p.email },
  }));
  const dnc = [
    { tenant_id: "t1", email: "owner@firm-c.ca", domain: null }, // the address opted out
    { tenant_id: "t1", email: null, domain: "firm-d.ca" }, // the whole domain opted out
    { tenant_id: "t2", email: "owner@firm-e.ca", domain: null }, // another tenant's list
  ];
  return { candidates, events, texts, dnc };
}

test("fetchExemplars: suppressed prospects and do-not-contact addresses or domains are never examples", async () => {
  process.env.EXEMPLARS_ENABLED = "1";
  try {
    const out = await fetchExemplars(fakeClient(world()) as never, "t1", TARGET, NOW);
    // a (booked: an outcome, not an opt-out) and e (another tenant's DNC entry) qualify;
    // b (suppressed), c (address, any case) and d (domain) never do.
    assert.deepEqual(out.map((e) => e.pitch_id).sort(), ["pitch-a", "pitch-e"]);
  } finally {
    delete process.env.EXEMPLARS_ENABLED;
  }
});

test("fetchExemplars: an unreadable do-not-contact list means no examples (fails closed)", async () => {
  process.env.EXEMPLARS_ENABLED = "1";
  try {
    assert.deepEqual(await fetchExemplars(fakeClient(world(), { dncFails: true }) as never, "t1", TARGET, NOW), []);
  } finally {
    delete process.env.EXEMPLARS_ENABLED;
  }
});

test("fetchExemplars: switch off reads nothing", async () => {
  delete process.env.EXEMPLARS_ENABLED;
  const client = { from() { throw new Error("no read with the switch off"); } };
  assert.deepEqual(await fetchExemplars(client as never, "t1", TARGET, NOW), []);
});

test("onDnc matches the address case-insensitively, or its whole domain", () => {
  const dnc = { emails: new Set(["owner@firm-c.ca"]), domains: new Set(["firm-d.ca"]) };
  assert.equal(onDnc(dnc, " Owner@FIRM-C.ca "), true);
  assert.equal(onDnc(dnc, "sales@firm-d.ca"), true);
  assert.equal(onDnc(dnc, "owner@firm-a.ca"), false);
  assert.equal(onDnc(dnc, null), false);
  assert.equal(onDnc(dnc, "not-an-address"), false);
});
