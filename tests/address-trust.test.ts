/**
 * Address trust (brief: tasks/briefs/address-trust.md). Anymail addresses are
 * kept only when Anymail marked them valid, stored as "anymail_verified", and
 * that source may send unattended. Every other selected_by value keeps the
 * provenance, finder flag, lane trust and gate result it had before.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { laneFor, type LaneInput } from "../lib/autopilot/governor.ts";
import { evaluateSendGate, type GateInput } from "../lib/pitches/send-gate.ts";
import {
  ANYMAIL_VERIFIED_SOURCE,
  anymailFindDecisionMaker,
  verifiedEmailOf,
} from "../lib/research/anymail-finder.ts";
import {
  isFinderSource,
  isTrustedForAutoSend,
  provenanceOf,
  storedVerdictUsable,
  verifyEmailPure,
  type Provenance,
  type Verdict,
} from "../lib/research/verify-recipient.ts";

// ── Anymail client ─────────────────────────────────────────────────────────────

async function withAnymail(body: unknown, run: () => Promise<void>, status = 200): Promise<void> {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANYMAIL_FINDER_API_KEY;
  process.env.ANYMAIL_FINDER_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANYMAIL_FINDER_API_KEY;
    else process.env.ANYMAIL_FINDER_API_KEY = realKey;
  }
}

const person = {
  person_full_name: "Henry Jonk",
  person_job_title: "Owner",
  person_linkedin_url: null,
  decision_maker_category: "ceo",
};

test("anymail: a valid address comes back as a contact with status valid", async () => {
  await withAnymail(
    { ...person, email: "Henry.Jonk@Acme.ca", valid_email: "Henry.Jonk@Acme.ca", email_status: "valid", credits_charged: 1 },
    async () => {
      const r = await anymailFindDecisionMaker("acme.ca");
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.contact.email, "henry.jonk@acme.ca");
      assert.equal(r.contact.email_status, "valid");
      assert.equal(r.contact.full_name, "Henry Jonk");
    },
  );
  assert.equal(ANYMAIL_VERIFIED_SOURCE, "anymail_verified");
});

test("anymail: valid_email null with a guessed email is no contact", async () => {
  await withAnymail({ ...person, email: "henry@acme.ca", valid_email: null, email_status: "risky" }, async () => {
    const r = await anymailFindDecisionMaker("acme.ca");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, "No valid email found");
    assert.equal(r.emailStatus, "risky");
  });
  // Even a status that claims "valid" needs valid_email itself.
  await withAnymail({ ...person, email: "henry@acme.ca", valid_email: null, email_status: "valid" }, async () => {
    assert.equal((await anymailFindDecisionMaker("acme.ca")).ok, false);
  });
});

test("anymail: risky is no contact, even with valid_email filled", async () => {
  await withAnymail({ ...person, email: "henry@acme.ca", valid_email: "henry@acme.ca", email_status: "risky" }, async () => {
    assert.equal((await anymailFindDecisionMaker("acme.ca")).ok, false);
  });
});

test("anymail: not_found and blacklisted are no contact", async () => {
  for (const email_status of ["not_found", "blacklisted"]) {
    await withAnymail({ email: null, valid_email: null, email_status }, async () => {
      assert.equal((await anymailFindDecisionMaker("acme.ca")).ok, false, email_status);
    });
  }
  await withAnymail({}, async () => assert.equal((await anymailFindDecisionMaker("acme.ca")).ok, false), 404);
});

test("anymail: verifiedEmailOf accepts only status valid plus valid_email", () => {
  assert.equal(verifiedEmailOf({ email_status: "valid", valid_email: " A@B.ca " }), "a@b.ca");
  assert.equal(verifiedEmailOf({ email_status: "VALID", valid_email: "a@b.ca" }), "a@b.ca");
  assert.equal(verifiedEmailOf({ email_status: "valid", valid_email: "", email: "a@b.ca" }), null);
  assert.equal(verifiedEmailOf({ email_status: "risky", valid_email: "a@b.ca" }), null);
  assert.equal(verifiedEmailOf({ email_status: undefined, valid_email: "a@b.ca" }), null);
  assert.equal(verifiedEmailOf({ email: "a@b.ca" }), null);
});

// ── One answer for every selected_by value ─────────────────────────────────────

type Row = { provenance: Provenance; finder: boolean; trusted: boolean; verdict: Verdict };

/** Before this change, from the old provenanceOf / FINDER_SOURCES / TRUSTED_SOURCES / VERIFIED_PROVENANCE. */
const TODAY: Record<string, Row> = {
  scraper: { provenance: "high", finder: false, trusted: true, verdict: "send" },
  manual: { provenance: "high", finder: false, trusted: true, verdict: "send" },
  snapverify_smtp: { provenance: "medium", finder: false, trusted: true, verdict: "send" },
  snapverify_catchall_guess: { provenance: "low", finder: false, trusted: false, verdict: "review" },
  engine: { provenance: "low", finder: false, trusted: false, verdict: "review" },
  anymail: { provenance: "medium", finder: true, trusted: true, verdict: "review" },
  hunter: { provenance: "medium", finder: true, trusted: true, verdict: "review" },
  "(null)": { provenance: "medium", finder: false, trusted: false, verdict: "send" },
};
const NEW: Record<string, Row> = {
  anymail_verified: { provenance: "medium", finder: false, trusted: true, verdict: "send" },
};
const ALL = { ...TODAY, ...NEW };
const val = (k: string) => (k === "(null)" ? null : k);

const NONE = new Set<string>();
const verdictFor = (selectedBy: string | null, bounced = NONE) =>
  verifyEmailPure({ email: "owner@acme.ca", selectedBy, prospectDomain: "acme.ca", bouncedDomains: bounced }, "mx");

test("table: provenance, finder flag, trust and verdict per selected_by", () => {
  for (const [k, want] of Object.entries(ALL)) {
    const s = val(k);
    assert.equal(provenanceOf(s), want.provenance, `${k} provenance`);
    assert.equal(isFinderSource(s), want.finder, `${k} finder`);
    assert.equal(isTrustedForAutoSend(s), want.trusted, `${k} trusted`);
    assert.equal(verdictFor(s).verdict, want.verdict, `${k} verdict`);
  }
});

const cleanLane: LaneInput = {
  gate: { pass: true, failures: [] },
  critic: { pass: true, score: 0.9 },
  verify: "send",
  recipientSelectedBy: "scraper",
  path: "claude",
};

function cleanGate(selectedBy: string | null): GateInput {
  return {
    subject: "who answers waghorn stephens at night?",
    body:
      "Hi John,\n\n" +
      "Henry from Runna Advertising here. We help Canadian law firms answer every " +
      "enquiry without adding staff.\n\n" +
      "We'd build you a simple assistant that replies to new enquiries right away and " +
      "passes each one to the right lawyer, so nothing sits overnight.\n\n" +
      "Worth a chat?\n\nHenry\nRunna Advertising",
    lang: "en",
    recipientEmail: "john.sipos@waglaw.net",
    recipientFullName: null,
    recipientSelectedBy: selectedBy,
    companyName: "Waghorn Stephens",
    siteName: "Waghorn Stephens Sipos and Poulton",
    domain: "waglaw.net",
    websiteVerified: true,
    evidenceQuotes: ["Small practice in St. Marys accepting walk-ins, no appointment needed"],
  };
}

test("table: governor lane and send gate agree with the predicate for every value", () => {
  for (const [k, want] of Object.entries(ALL)) {
    const s = val(k);
    const lane = laneFor({ ...cleanLane, recipientSelectedBy: s });
    const untrusted = lane.reasons.some((r) => r.startsWith("address source "));
    assert.equal(!untrusted, want.trusted, `${k} lane trust`);
    const gate = evaluateSendGate(cleanGate(s));
    const flagged = !gate.pass && gate.failures.some((f) => f.code === "unverified_recipient");
    assert.equal(!flagged, want.trusted, `${k} gate trust`);
    // End to end: AUTO only with a trusted source AND the verifier's own "send".
    const e2e = laneFor({ ...cleanLane, recipientSelectedBy: s, verify: verdictFor(s).verdict });
    assert.equal(e2e.lane === "auto", want.trusted && want.verdict === "send", `${k} end to end`);
  }
});

test("anymail_verified sends unattended; legacy anymail still needs a person", () => {
  const verified = laneFor({ ...cleanLane, recipientSelectedBy: "anymail_verified", verify: verdictFor("anymail_verified").verdict });
  assert.deepEqual(verified, { lane: "auto", reasons: [] });
  const legacy = laneFor({ ...cleanLane, recipientSelectedBy: "anymail", verify: verdictFor("anymail").verdict });
  assert.equal(legacy.lane, "review");
});

test("anymail_verified on a domain that already bounced is dropped", () => {
  const r = verdictFor("anymail_verified", new Set(["acme.ca"]));
  assert.equal(r.verdict, "drop");
  assert.equal(verdictFor("scraper", new Set(["acme.ca"])).verdict, "send");
});

test("anymail_verified: a stored send verdict is reused; legacy anymail's is not", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const checkedAt = "2026-10-18T12:00:00Z";
  assert.equal(storedVerdictUsable({ verdict: "send", checkedAt, selectedBy: "anymail_verified" }, now), true);
  assert.equal(storedVerdictUsable({ verdict: "send", checkedAt, selectedBy: "anymail" }, now), false);
});

test("the 2026-10-19 cases keep their verdicts", () => {
  const henry = verifyEmailPure(
    { email: "henry.jonk@absolute-hydraulics.com", selectedBy: "anymail", prospectDomain: "absolute-hydraulics.com", bouncedDomains: NONE },
    "mx",
  );
  assert.equal(henry.verdict, "review");
  const dentist = verifyEmailPure(
    { email: "contacto@dentistaenguadalajara.com", selectedBy: "scraper", prospectDomain: "dentistaenguadalajara.com", bouncedDomains: NONE },
    "mx",
  );
  assert.equal(dentist.verdict, "send");
});
