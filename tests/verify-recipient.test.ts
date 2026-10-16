/**
 * SPAM Verify. Fixtures marked "real" are addresses S.P.A.M. actually emailed
 * and that bounced (or shouldn't have been pitched), Jun–Aug 2026.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  checkDomainMail,
  provenanceOf,
  registrableDomain,
  verifyEmailPure,
  type MxResolver,
} from "../lib/research/verify-recipient.ts";

const NONE = new Set<string>();
const v = (email: string, selectedBy: string | null, prospectDomain: string | null, dns: Parameters<typeof verifyEmailPure>[1] = "mx", bounced = NONE) =>
  verifyEmailPure({ email, selectedBy, prospectDomain, bouncedDomains: bounced }, dns);

test("registrable domain handles CA/MX second-level suffixes and subdomains", () => {
  assert.equal(registrableDomain("www.acme.ca"), "acme.ca");
  assert.equal(registrableDomain("mail.acme.com.mx"), "acme.com.mx");
  assert.equal(registrableDomain("sbghc.on.ca"), "sbghc.on.ca");
  assert.equal(registrableDomain("hr.sbghc.on.ca"), "sbghc.on.ca");
  assert.equal(registrableDomain("ACME.COM."), "acme.com");
});

test("real junk addresses are dropped by format", () => {
  for (const email of [
    "info@pacemanufacturing.comcopyright",
    "page403-928-3987info@destinybuilders.caabout",
    "ejemplo@misitio.com",
  ]) {
    assert.equal(v(email, "scraper", null).verdict, "drop", email);
  }
});

test("real: glue that forms a legal hostname is caught by DNS, not format", () => {
  // "delcan.ca" + "www.delpro1638.com" glued: valid syntax, nonexistent domain.
  const r = v("sales@delcan.cawww.delpro1638.com", "scraper", "delcan.ca", "nxdomain");
  assert.equal(r.verdict, "drop");
  assert.match(r.reasons.join(" "), /doesn't exist/);
});

test("real: a hospital volunteer desk is never pitched", () => {
  const r = v("volunteer@haltonhealthcare.com", "scraper", "haltonhealthcare.com");
  assert.equal(r.verdict, "drop");
  assert.match(r.reasons.join(" "), /never buys/);
});

test("real: a directory's domain is not the prospect's (asicentral.com)", () => {
  const r = v("asi231521@asicentral.com", "scraper", "rollshutter.ca");
  assert.equal(r.verdict, "review");
  assert.match(r.reasons.join(" "), /isn't the prospect's site/);
});

test("real: a Claude-picked address is a guess → review, never auto-send", () => {
  const r = v("sbassett@bassettcompanies.com", "engine", "bassettcompanies.com");
  assert.equal(r.provenance, "low");
  assert.equal(r.verdict, "review");
});

test("published on the company's own domain with MX → send", () => {
  const r = v("info@woodbinehotels.com", "scraper", "woodbinehotels.com");
  assert.deepEqual(r, { verdict: "send", provenance: "high", reasons: [] });
});

test("DNS: a missing domain, null MX or no mail server drops; A-only or unknown needs review", () => {
  assert.equal(v("a@acme.ca", "scraper", "acme.ca", "nxdomain").verdict, "drop");
  assert.equal(v("a@acme.ca", "scraper", "acme.ca", "null_mx").verdict, "drop");
  assert.equal(v("a@acme.ca", "scraper", "acme.ca", "no_mail").verdict, "drop");
  assert.equal(v("a@acme.ca", "scraper", "acme.ca", "a_only").verdict, "review");
  assert.equal(v("a@acme.ca", "scraper", "acme.ca", "unknown").verdict, "review");
});

test("a domain that already hard-bounced only accepts published addresses", () => {
  const bounced = new Set(["acme.ca"]);
  assert.equal(v("guess@acme.ca", "hunter", "acme.ca", "mx", bounced).verdict, "drop");
  assert.equal(v("info@acme.ca", "scraper", "acme.ca", "mx", bounced).verdict, "send");
});

test("free-mail: fine when the company publishes it, review when guessed", () => {
  assert.equal(v("tallerlopez@gmail.com", "scraper", "tallerlopez.mx").verdict, "send");
  assert.equal(v("tallerlopez@gmail.com", "hunter", "tallerlopez.mx").verdict, "review");
});

test("provenance tiers", () => {
  assert.equal(provenanceOf("scraper"), "high");
  assert.equal(provenanceOf("manual"), "high");
  assert.equal(provenanceOf("anymail"), "medium");
  assert.equal(provenanceOf(null), "medium");
  assert.equal(provenanceOf("snapverify_catchall_guess"), "low");
});

function fakeResolver(
  answers: {
    mx?: Array<{ exchange: string; priority: number }> | string;
    a?: string[] | string;
    aaaa?: string[] | string;
  },
  opts: { healthy?: boolean } = {},
): MxResolver {
  const reply = <T,>(a: T | string | undefined, empty: T): Promise<T> =>
    typeof a === "string" ? Promise.reject(Object.assign(new Error(a), { code: a })) : Promise.resolve(a ?? empty);
  const healthy = opts.healthy ?? true;
  return {
    resolveMx: (host: string) =>
      host === "gmail.com" || host === "outlook.com"
        ? reply(healthy ? [{ exchange: "mx.google.com", priority: 5 }] : "ENOTFOUND", [])
        : reply(answers.mx, []),
    resolve4: () => reply(answers.a, []),
    resolve6: () => reply(answers.aaaa, []),
  };
}

test("checkDomainMail maps resolver answers to definite or unknown states", async () => {
  assert.equal(await checkDomainMail("x", fakeResolver({ mx: [{ exchange: "mx.acme.ca", priority: 10 }] })), "mx");
  assert.equal(await checkDomainMail("x", fakeResolver({ mx: [{ exchange: "", priority: 0 }] })), "null_mx");
  assert.equal(await checkDomainMail("x", fakeResolver({ mx: "ENOTFOUND" })), "nxdomain");
  assert.equal(await checkDomainMail("x", fakeResolver({ mx: "ENODATA", a: ["1.2.3.4"] })), "a_only");
  assert.equal(await checkDomainMail("x", fakeResolver({ mx: "ENODATA", a: "ENODATA", aaaa: "ENODATA" })), "no_mail");
  assert.equal(await checkDomainMail("x", fakeResolver({ mx: "ETIMEOUT" })), "unknown");
  assert.equal(await checkDomainMail("x", fakeResolver({ mx: "ENODATA", a: "ESERVFAIL" })), "unknown");
});

test("a resolver that can't see gmail.com makes every negative answer 'unknown'", async () => {
  // What this sandbox does: ENOTFOUND for everything. Must never mean "drop".
  const broken = fakeResolver({ mx: "ENOTFOUND", a: "ENOTFOUND", aaaa: "ENOTFOUND" }, { healthy: false });
  assert.equal(await checkDomainMail("woodbinehotels.com", broken), "unknown");
  assert.equal(await checkDomainMail("x", fakeResolver({ mx: [{ exchange: "", priority: 0 }] }, { healthy: false })), "unknown");
});
