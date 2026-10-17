/**
 * Addresses used to test S.P.A.M., which must never count as real outreach.
 *
 * The GYMVMT "positive reply" in the audit was Pedro's own test from
 * pedrojr22@gmail.com, and it was counted as a real reply. Metrics and the
 * learning loop ask this module instead of trusting every reply.
 *
 * RUNNA_TEST_EMAILS (comma-separated) overrides the default. A Gmail "+tag" or
 * dot doesn't make a different person: pedrojr22+test1@gmail.com and
 * pedro.jr22@gmail.com are the same inbox, so they match too.
 *
 * Pure — tested in tests/test-addresses.test.ts.
 */

const DEFAULT_TEST_EMAILS = ["pedrojr22@gmail.com"];

/** Lower-case, drop a +tag, and for Gmail drop the dots in the local part. */
export function normalizeMailbox(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  let local = e.slice(0, at).split("+")[0] ?? "";
  const domain = e.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") local = local.replace(/\./g, "");
  return `${local}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
}

export function testAddresses(): string[] {
  const raw = process.env.RUNNA_TEST_EMAILS?.trim();
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_TEST_EMAILS;
  return list.map(normalizeMailbox);
}

export function isTestAddress(email: string | null | undefined): boolean {
  if (!email) return false;
  return testAddresses().includes(normalizeMailbox(email));
}
