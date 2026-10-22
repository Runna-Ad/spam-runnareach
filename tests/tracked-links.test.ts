/**
 * Brief tasks/briefs/tracked-links.md: every email carries the free-check link
 * as our tracked redirect /r/<code>, a click is recorded once on the ROOT pitch,
 * the redirect only ever goes to the free check, follow-ups carry the root's
 * link as their one CTA, and a rewrite never inherits an old code.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../lib/anthropic/client.ts";
import { composePitchWithClaude, heldBodyForRevision } from "../lib/pitches/claude-composer.ts";
import { composeFollowupWithClaude, enforceFollowupCta, type FollowupComposerInput } from "../lib/pitches/followup-composer.ts";
import { buildFollowup1, buildFollowup2, type FollowupContext } from "../lib/pitches/followup-templates.ts";
import { buildHunterUrl, buildHunterUrlForPitch } from "../lib/pitches/hunter-mapping.ts";
import { HUNTER_URL } from "../lib/pitches/industry-templates.ts";
import { evaluateSendGate } from "../lib/pitches/send-gate.ts";
import { senderSignature } from "../lib/pitches/sender-identity.ts";
import type { GeneratorInputs } from "../lib/pitches/generator.ts";
import {
  CLICK_DEDUPE_MS,
  buildTrackedLink,
  followupHunterLink,
  hunterDestination,
  hunterParamsFromBody,
  isScannerUserAgent,
  planTrackedClick,
  type ClickOutcome,
} from "../lib/pitches/tracked-links.ts";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

const BASE = "https://spam-runnareach.vercel.app";
const CODE = "ab3kx9mz";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const PITCH_INPUT = {
  language: "en" as const,
  market: "CA",
  industry: "law firm",
  employeeEstimate: 8,
  painLabel: "Slow lead response",
  techStack: ["WordPress"],
  domain: "smithlaw.ca",
  websiteUrl: null,
};

// ── Fake db: the columns of the real tables only (0001 + 0038) ──────────────

const COLUMNS: Record<string, string[]> = {
  pitches: ["id", "tenant_id", "prospect_id", "contact_id", "parent_pitch_id", "attribution_code", "status", "sent_at"],
  prospect_contacts: ["id", "email", "full_name"],
  pitch_events: ["id", "tenant_id", "pitch_id", "event_type", "event_at", "payload", "ip_address", "user_agent"],
};
type Row = Record<string, unknown>;

function fakeDb(seed: { pitches?: Row[]; prospect_contacts?: Row[]; pitch_events?: Row[] }, opts: { failPitches?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    pitches: [...(seed.pitches ?? [])],
    prospect_contacts: [...(seed.prospect_contacts ?? [])],
    pitch_events: [...(seed.pitch_events ?? [])],
  };
  const check = (table: string, col: string) => {
    if (!COLUMNS[table]?.includes(col)) throw new Error(`fake db: ${table}.${col} does not exist`);
  };
  const client = {
    tables,
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let lim = Infinity;
      const q = {
        select(cols: string) {
          for (const c of cols.split(",").map((s) => s.trim())) check(table, c);
          return q;
        },
        eq(col: string, v: unknown) { check(table, col); filters.push((r) => r[col] === v); return q; },
        gte(col: string, v: string) { check(table, col); filters.push((r) => String(r[col]) >= v); return q; },
        limit(n: number) { lim = n; return q; },
        rows() { return tables[table]!.filter((r) => filters.every((f) => f(r))).slice(0, lim); },
        async maybeSingle() {
          if (opts.failPitches && table === "pitches") return { data: null, error: { message: "" } };
          return { data: q.rows()[0] ?? null, error: null };
        },
        then(res: (v: { data: Row[]; error: null }) => unknown) { return Promise.resolve({ data: q.rows(), error: null }).then(res); },
        async insert(row: Row) {
          for (const c of Object.keys(row)) check(table, c);
          tables[table]!.push({ id: `ev-${tables[table]!.length + 1}`, event_at: new Date().toISOString(), ...row });
          return { error: null };
        },
      };
      return q;
    },
  };
  return client;
}

const ROOT = { id: "root-1", tenant_id: "t1", prospect_id: "pr1", contact_id: "c1", parent_pitch_id: null, attribution_code: CODE };
const FU = { id: "fu-1", tenant_id: "t1", prospect_id: "pr1", contact_id: "c1", parent_pitch_id: "root-1", attribution_code: null };
function db(over: { contactEmail?: string; events?: Row[]; failPitches?: boolean } = {}) {
  return fakeDb(
    {
      pitches: [ROOT, FU],
      prospect_contacts: [{ id: "c1", email: over.contactEmail ?? "sarah@smithlaw.ca", full_name: "Sarah Smith" }],
      pitch_events: over.events ?? [],
    },
    { failPitches: over.failPitches },
  );
}

function trackedSearch(extra = ""): URLSearchParams {
  const link = buildHunterUrlForPitch({ ...PITCH_INPUT, ref: CODE });
  return new URL(link + extra).searchParams;
}

async function click(client: ReturnType<typeof fakeDb>, over: Partial<{ code: string; method: string; ua: string | null; search: URLSearchParams }> = {}) {
  const plan = await planTrackedClick(client, {
    code: over.code ?? CODE,
    method: over.method ?? "GET",
    userAgent: over.ua === undefined ? CHROME : over.ua,
    search: over.search ?? trackedSearch(),
  });
  const outcome: ClickOutcome | null = plan.record ? await plan.record() : null;
  return { location: plan.location, outcome, events: client.tables.pitch_events! };
}

// ── Link building ───────────────────────────────────────────────────────────

test("first-email link: /r/<code> with the same Hunter params, no r, no v; the redirect restores them", () => {
  // Today's direct link for the same pitch: the untracked form plus &r=.
  const direct = new URL(buildHunterUrlForPitch({ ...PITCH_INPUT, ref: null }));
  direct.searchParams.set("r", CODE);
  const tracked = new URL(buildHunterUrlForPitch({ ...PITCH_INPUT, ref: CODE }));
  assert.equal(tracked.origin, BASE);
  assert.equal(tracked.pathname, `/r/${CODE}`);
  assert.equal(tracked.searchParams.has("r"), false);
  assert.equal(tracked.searchParams.has("v"), false);
  assert.equal(tracked.searchParams.has("s"), false, "step 0 is implicit");
  // Every parameter the free check receives today, same names and values.
  const dest = new URL(hunterDestination(tracked.searchParams, CODE));
  assert.equal(`${dest.origin}${dest.pathname}`, HUNTER_URL);
  assert.deepEqual([...dest.searchParams.entries()].sort(), [...direct.searchParams.entries()].sort());
});

test("no attribution code → the direct Hunter link, exactly as before", () => {
  const url = buildHunterUrlForPitch({ ...PITCH_INPUT, ref: null });
  assert.ok(url.startsWith(`${HUNTER_URL}?market=ca`), url);
  assert.ok(url.endsWith("&v=1"), url);
  assert.ok(!url.includes("/r/"));
});

test("link base follows UNSUBSCRIBE_BASE_URL, then NEXT_PUBLIC_APP_URL (same as the unsubscribe link)", () => {
  const saved = { u: process.env.UNSUBSCRIBE_BASE_URL, n: process.env.NEXT_PUBLIC_APP_URL };
  try {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com/";
    delete process.env.UNSUBSCRIBE_BASE_URL;
    assert.ok(buildHunterUrlForPitch({ ...PITCH_INPUT, ref: CODE }).startsWith(`https://app.example.com/r/${CODE}?`));
    process.env.UNSUBSCRIBE_BASE_URL = "https://u.example.com";
    assert.ok(buildHunterUrlForPitch({ ...PITCH_INPUT, ref: CODE }).startsWith(`https://u.example.com/r/${CODE}?`));
  } finally {
    if (saved.u === undefined) delete process.env.UNSUBSCRIBE_BASE_URL; else process.env.UNSUBSCRIBE_BASE_URL = saved.u;
    if (saved.n === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = saved.n;
  }
});

// ── Acceptance 1: the redirect ──────────────────────────────────────────────

test("valid code → free check with every param + r=<code>, one click recorded on the root", async () => {
  const d = db();
  const r = await click(d);
  const dest = new URL(r.location);
  assert.equal(`${dest.origin}${dest.pathname}`, HUNTER_URL);
  assert.equal(dest.searchParams.get("r"), CODE);
  assert.equal(dest.searchParams.get("v"), "1");
  for (const p of ["market", "industry", "size", "timesink", "tools", "website", "lead"]) assert.ok(dest.searchParams.get(p), p);
  assert.equal(r.outcome, "recorded");
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.pitch_id, "root-1");
  assert.equal(r.events[0]!.event_type, "click");
  assert.deepEqual(r.events[0]!.payload, { code: CODE, step: 0, ua: CHROME });
});

test("unknown or malformed code → free check without r, nothing recorded, never an error", async () => {
  for (const code of ["zzzzzzzz", "AB3KX9MZ", "short", "ab3kx9mz0", "../../x", "", "ab3kx9m%"]) {
    const d = db();
    const r = await click(d, { code });
    const dest = new URL(r.location);
    assert.equal(`${dest.origin}${dest.pathname}`, HUNTER_URL, code);
    assert.equal(dest.searchParams.has("r"), false, code);
    assert.equal(dest.searchParams.get("market"), "ca", code);
    assert.equal(r.events.length, 0, code);
  }
});

test("a lookup error still redirects to the free check (with r: the code is well-formed) and records nothing", async () => {
  const r = await click(db({ failPitches: true }));
  assert.ok(r.location.startsWith(HUNTER_URL));
  assert.equal(new URL(r.location).searchParams.get("r"), CODE);
  assert.equal(r.outcome, null);
});

test("attacker-supplied host / to / next / r params are ignored: the host is a constant", async () => {
  const evil = trackedSearch("&to=https://evil.example&host=evil.example&next=//evil.example&url=https://evil.example&r=OTHERCODE&v=9");
  const r = await click(db(), { search: evil });
  const dest = new URL(r.location);
  assert.equal(dest.host, "runna-hunter.vercel.app");
  assert.ok(!r.location.includes("evil"), r.location);
  assert.equal(dest.searchParams.get("r"), CODE);
  assert.equal(dest.searchParams.getAll("r").length, 1);
  assert.equal(dest.searchParams.get("v"), "1");
  for (const p of ["to", "host", "next", "url"]) assert.equal(dest.searchParams.has(p), false, p);
  // Property: whatever the query holds, the destination is the free check.
  const rnd = mulberry32(7);
  for (let i = 0; i < 300; i++) {
    const q = new URLSearchParams();
    for (let k = 0; k < 4; k++) q.set(pick(rnd, ["market", "lead", "to", "website", "redirect", "@", "//"]), pick(rnd, ["//evil.com", "https://evil.com", "ca", "\\\\evil", "@evil.com", "%2F%2Fevil"]));
    const loc = hunterDestination(q, rnd() < 0.5 ? CODE : null);
    assert.equal(new URL(loc).host, "runna-hunter.vercel.app", loc);
    assert.ok(loc.startsWith(HUNTER_URL), loc);
  }
});

test("an over-long param value is dropped, not forwarded", () => {
  const q = new URLSearchParams({ market: "ca", website: "x".repeat(500) });
  const dest = new URL(hunterDestination(q, null));
  assert.equal(dest.searchParams.has("website"), false);
  assert.equal(dest.searchParams.get("market"), "ca");
});

test("HEAD records nothing (still redirects)", async () => {
  const r = await click(db(), { method: "HEAD" });
  assert.ok(r.location.startsWith(HUNTER_URL));
  assert.equal(r.outcome, "head");
  assert.equal(r.events.length, 0);
});

test("scanner and prefetcher user agents record nothing", async () => {
  const scanners = [
    null,
    "",
    "Mozilla/5.0 (compatible; Barracuda Sentinel)",
    "Proofpoint URL Defense",
    "Mimecast-Url-Protect/1.0",
    "Microsoft Office Existence Discovery",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Slackbot-LinkExpanding 1.0",
    "facebookexternalhit/1.1",
    "python-requests/2.31",
    "curl/8.4.0",
    "Mozilla/5.0 (Windows NT 10.0) HeadlessChrome/120.0",
    "SafeLinks/1.0",
    "LinkPreview/2.0",
  ];
  for (const ua of scanners) {
    const r = await click(db(), { ua });
    assert.equal(r.outcome, "scanner", String(ua));
    assert.equal(r.events.length, 0, String(ua));
  }
  for (const ua of [CHROME, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"]) {
    assert.equal(isScannerUserAgent(ua), false, ua);
  }
});

test("a second click within 10 minutes records nothing; after 10 minutes it records again", async () => {
  const d = db();
  assert.equal((await click(d)).outcome, "recorded");
  assert.equal((await click(d, { search: trackedSearch("&s=2") })).outcome, "duplicate");
  assert.equal(d.tables.pitch_events!.length, 1);
  // An older click (outside the window) does not block.
  const old = new Date(Date.now() - CLICK_DEDUPE_MS - 60_000).toISOString();
  const d2 = db({ events: [{ id: "e0", tenant_id: "t1", pitch_id: "root-1", event_type: "click", event_at: old, payload: {} }] });
  assert.equal((await click(d2)).outcome, "recorded");
  // Another event type in the window does not block.
  const d3 = db({ events: [{ id: "e0", tenant_id: "t1", pitch_id: "root-1", event_type: "sent", event_at: new Date().toISOString(), payload: {} }] });
  assert.equal((await click(d3)).outcome, "recorded");
});

test("a test-address pitch records nothing (Gmail dots and +tags included), but still redirects with r", async () => {
  for (const email of ["pedrojr22@gmail.com", "pedro.jr22+x@gmail.com", "PedroJr22@googlemail.com"]) {
    const r = await click(db({ contactEmail: email }));
    assert.equal(r.outcome, "test_address", email);
    assert.equal(r.events.length, 0, email);
    assert.equal(new URL(r.location).searchParams.get("r"), CODE);
  }
});

test("no readable recipient → records nothing (fails closed on the test-address rule)", async () => {
  const d = fakeDb({ pitches: [{ ...ROOT, contact_id: null }] });
  assert.equal((await click(d)).outcome, "recipient_unknown");
  const d2 = fakeDb({ pitches: [ROOT], prospect_contacts: [] });
  assert.equal((await click(d2)).outcome, "recipient_unknown");
  assert.equal(d.tables.pitch_events!.length + d2.tables.pitch_events!.length, 0);
});

// ── Acceptance 2: clicks land on the ROOT ───────────────────────────────────

test("a follow-up link (s=2) records on the same root pitch, with step 2", async () => {
  const link = followupHunterLink({ rootCode: CODE, followupStep: 2, rootBody: null, fallback: trackedSearch() });
  const u = new URL(link);
  assert.equal(u.pathname, `/r/${CODE}`);
  const d = db();
  const r = await click(d, { code: u.pathname.split("/").pop()!, search: u.searchParams });
  assert.equal(r.outcome, "recorded");
  assert.equal(r.events[0]!.pitch_id, "root-1");
  assert.deepEqual(r.events[0]!.payload, { code: CODE, step: 2, ua: CHROME });
});

test("a code that somehow sits on a child row still records on its parent (the root)", async () => {
  const d = fakeDb({
    pitches: [{ ...ROOT, attribution_code: null }, { ...FU, attribution_code: CODE }],
    prospect_contacts: [{ id: "c1", email: "sarah@smithlaw.ca", full_name: null }],
  });
  const r = await click(d);
  assert.equal(r.events[0]?.pitch_id, "root-1");
});

test("the ua payload is clipped to 200 chars", async () => {
  const ua = CHROME + " X".repeat(200);
  const r = await click(db(), { ua });
  assert.equal((r.events[0]!.payload as { ua: string }).ua.length, 200);
});

// ── Follow-up link plumbing ─────────────────────────────────────────────────

test("followupHunterLink: reuses the root email's own link params (tracked or old direct form)", () => {
  const rootTracked = `Hi Sarah,\n\n👉 Run it: ${buildHunterUrlForPitch({ ...PITCH_INPUT, ref: CODE })}.\n\nHenry`;
  const rootDirect = `Hi Sarah,\n\n👉 Run it: ${buildHunterUrl({ market: "mx", industry: "retail", lead: "abc", ref: CODE })}\n\nNils`;
  const fallback = new URLSearchParams({ market: "ca", industry: "other" });
  const a = new URL(followupHunterLink({ rootCode: CODE, followupStep: 1, rootBody: rootTracked, fallback }));
  assert.equal(a.pathname, `/r/${CODE}`);
  assert.equal(a.searchParams.get("industry"), "proservices");
  assert.equal(a.searchParams.get("s"), "1");
  const b = new URL(followupHunterLink({ rootCode: CODE, followupStep: 2, rootBody: rootDirect, fallback }));
  assert.equal(b.searchParams.get("market"), "mx");
  assert.equal(b.searchParams.get("lead"), "abc");
  assert.equal(b.searchParams.has("r"), false);
  assert.equal(b.searchParams.get("s"), "2");
  // No link in the root body → the fallback params.
  const c = new URL(followupHunterLink({ rootCode: CODE, followupStep: 1, rootBody: "no link", fallback }));
  assert.equal(c.searchParams.get("industry"), "other");
  // A root without a code (older pitch) → the direct free-check link, untracked.
  const d = followupHunterLink({ rootCode: null, followupStep: 1, rootBody: rootDirect, fallback });
  assert.ok(d.startsWith(`${HUNTER_URL}?market=mx`), d);
  assert.ok(!d.includes("r="), d);
  assert.equal(hunterParamsFromBody("see https://example.com/r/abcdefgh?market=ca")?.get("market"), "ca");
  assert.equal(hunterParamsFromBody("see https://example.com/page"), null);
});

test("buildTrackedLink drops anything that isn't a Hunter param", () => {
  const link = buildTrackedLink({ code: CODE, params: new URLSearchParams({ market: "ca", to: "x", r: "y", v: "1" }), step: 1, base: BASE });
  assert.equal(link, `${BASE}/r/${CODE}?market=ca&s=1`);
});

// ── Acceptance 3: follow-up composer + templates ────────────────────────────

const FU_LINK = `${BASE}/r/${CODE}?market=ca&industry=proservices&s=1`;

function fuInput(over: Partial<FollowupComposerInput> = {}): FollowupComposerInput {
  return {
    step: 2, companyName: "Smith Law", contactFirstName: "Sarah", language: "en", market: "CA", industry: "law firm",
    city: "Calgary", originalSubject: "who answers smith law at night", originalBody: "Hi Sarah,\n\nfirst email",
    painSummary: null, evidenceQuote: null, whatTheyDo: "family law firm", techStack: [], hunterValue: null,
    senderFirstName: "Henry", agencyName: "Runna Advertising", hunterUrl: FU_LINK, ...over,
  };
}

type Req = { system?: { text: string }[] | string; messages: { content: string }[] };
const sysText = (r: Req) => (typeof r.system === "string" ? r.system : (r.system ?? []).map((b) => b.text).join("\n"));
function install(body: string) {
  const calls: Req[] = [];
  __test__.setClient({
    messages: {
      create: async (r: Req) => {
        calls.push(r);
        return { content: [{ type: "text", text: JSON.stringify({ subject: "Re: x", body, reasoning: "r" }) }], usage: { input_tokens: 100, output_tokens: 50 } };
      },
    },
  } as never);
  return calls;
}

test("follow-up composer: prompt requires the free-check link, no 20-minute chat or call request; payload carries the tracked link", async () => {
  for (const step of [2, 3] as const) {
    for (const language of ["en", "es"] as const) {
      const calls = install(`Hi Sarah,\n\nA fresh angle here.\n\n👉 ${FU_LINK}\n\nHenry\nRunna Advertising`);
      const r = await composeFollowupWithClaude(fuInput({ step, language }));
      assert.equal(r.ok, true);
      const sys = sysText(calls[0]!);
      const user = calls[0]!.messages[0]!.content;
      for (const text of [sys, user]) {
        assert.doesNotMatch(text, /20[- ]min|quick 20|coffee|café/i, `${step}/${language}`);
        assert.doesNotMatch(text, /(push|nudge)[^.\n]*(chat|call)/i, `${step}/${language}`);
      }
      assert.match(sys, /REQUIRED/);
      assert.match(sys, /Never ask for a call/);
      assert.match(sys, /own line starting with 👉/);
      assert.match(user, /hunter_url on its own 👉 line/);
      assert.equal(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(user)![1]!).hunter_url, FU_LINK);
    }
  }
});

test("follow-up composer: a body without the link line is refused (usage returned, so the caller records it and sends the template)", async () => {
  install("Hi Sarah,\n\nNo link at all here, just words.\n\nHenry\nRunna Advertising");
  const r = await composeFollowupWithClaude(fuInput());
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "missing_cta");
  assert.ok(r.usage);
});

test("follow-up composer: {hunter_url}, a bare Hunter link or one without 👉 all end as the tracked link on a 👉 line", () => {
  for (const line of ["Run the free check: {hunter_url}", `Free check: ${HUNTER_URL}`, `Free check: ${HUNTER_URL}?market=ca&r=OLD.`, `👉 ${FU_LINK}`, FU_LINK]) {
    const out = enforceFollowupCta(`Hi Sarah,\n\n${line}\n\nHenry`, FU_LINK)!;
    assert.ok(out, line);
    const cta = out.split("\n").find((l) => l.includes(FU_LINK));
    assert.ok(cta?.trim().startsWith("👉"), `${line} → ${out}`);
    assert.doesNotMatch(out, /OLD|\{hunter_url\}/);
    assert.equal(out.split(FU_LINK).length - 1, 1);
  }
});

function tctx(over: Partial<FollowupContext> = {}): FollowupContext {
  return { prospectName: "Casa Norte", contactName: "Ana", originalSubject: "una idea", painLabel: null, lang: "es", signature: senderSignature("es"), hunterUrl: FU_LINK, ...over };
}

test("template fallback: both steps, both languages carry the 👉 tracked line, no call or 20 minutes, and pass the send gate", () => {
  for (const lang of ["en", "es"] as const) {
    for (const build of [buildFollowup1, buildFollowup2]) {
      const e = build(tctx({ lang, signature: senderSignature(lang), painLabel: lang === "en" ? "online booking" : null }));
      const cta = e.body.split("\n").filter((l) => l.includes(FU_LINK));
      assert.equal(cta.length, 1, e.body);
      assert.ok(cta[0]!.startsWith("👉 "), e.body);
      assert.doesNotMatch(e.body, /20|call|chat|coffee|llamada|café/i, e.body);
      assert.ok(e.body.endsWith(`\n\n${senderSignature(lang)}`), e.body);
      const gate = evaluateSendGate({
        subject: e.subject, body: e.body, lang,
        recipientEmail: "ana@casanorte.mx", recipientFullName: "Ana López", recipientSelectedBy: null,
        companyName: "Casa Norte", siteName: null, domain: "casanorte.mx", websiteVerified: true,
        evidenceQuotes: [], benchmarkFigures: [], clientNames: ["DiDi"], checkRecipientSource: false,
      });
      assert.ok(gate.pass, `${lang}/${build.name}: ${JSON.stringify(gate)}`);
    }
  }
});

// ── Acceptance 4: a rewrite never carries the old code ──────────────────────

test("heldBodyForRevision: both the old direct link and the new tracked link go back to {hunter_url}", () => {
  const tracked = `Hi Sarah,\n\n👉 Run Smith Law through our free check: ${BASE}/r/${CODE}?market=ca&industry=proservices.\n\nHenry\nRunna Advertising`;
  const other = `Hi Sarah,\n\n👉 Free check: https://preview-abc.vercel.app/r/${CODE}\n\nHenry`;
  const direct = `Hi Sarah,\n\n👉 Free check: ${HUNTER_URL}?market=ca&r=${CODE}&v=1\n\nHenry`;
  assert.ok(heldBodyForRevision(tracked).includes("free check: {hunter_url}."), heldBodyForRevision(tracked));
  for (const b of [tracked, other, direct]) {
    const out = heldBodyForRevision(b);
    assert.ok(!out.includes(CODE), out);
    assert.ok(out.includes("{hunter_url}"), out);
  }
  // A prospect's own /r/ page with a non-code segment is left alone.
  assert.ok(heldBodyForRevision("see https://example.com/r/about-us").includes("https://example.com/r/about-us"));
});

test("rewrite with a writer that copies its input: the new body carries the NEW tracked link, never the old code", async () => {
  const OLD = "pqrstuv2";
  const NEW_CODE = "newc2de3";
  const held = `Hi Sarah,\n\nHenry from Runna Advertising here. Right now the only way to reach Smith Law online is a contact form.\n\n👉 Run Smith Law through our free check: ${BASE}/r/${OLD}?market=ca&industry=proservices\n\nHenry\nRunna Advertising`;
  __test__.setClient({
    messages: {
      create: async (r: Req) => {
        const prev = /Previous draft:\nSubject: [^\n]*\n([\s\S]*?)\n+```json/.exec(r.messages[0]!.content)?.[1]?.trim() ?? "";
        const text = JSON.stringify({
          subject: "contact form only at smith law", preview_text: "the only way in after hours", body: prev,
          pain_id: null, contact_email: "sarah@smithlaw.ca", measurable_result_included: false, quality_self_score: 0.8, reasoning: "x",
        });
        return { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } };
      },
    },
  } as never);
  const inputs: GeneratorInputs = {
    prospect: { id: "p", company_name: "Smith Law", industry: "law firm", language: "en", employee_size_estimate: 8, city: "Calgary", market: "CA", what_they_do: "family law firm", tech_stack: [] },
    pains: [{ pain_id: "pain-1", pain_label: "Lead response time", evidence_quote: "contact form only, no booking" }],
    contacts: [{ full_name: "Sarah Smith", email: "sarah@smithlaw.ca", email_is_role_based: false, role_title: null }],
    case_studies: [], notable_clients: [], benchmarks: [],
    sender: { full_name: "Henry", tenant_display_name: "Runna Advertising" },
    deep_pitch_url: buildHunterUrlForPitch({ ...PITCH_INPUT, ref: NEW_CODE }),
  };
  const r = await composePitchWithClaude({ ...inputs, revision: { subject: "s", body: heldBodyForRevision(held), issues: ["fix it"] } });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;
  const body = r.result.composed.body;
  assert.ok(body.includes(`/r/${NEW_CODE}?`), body);
  assert.ok(!body.includes(OLD), body);
});

// ── helpers ─────────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick<T>(rnd: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length)]!;
}
