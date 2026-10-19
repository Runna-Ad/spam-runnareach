/**
 * The enrichment waterfall stores an Anymail address as "anymail_verified"
 * (brief: tasks/briefs/address-trust.md), and stores nothing from Anymail when
 * Anymail did not verify it. Drives the real enrichContactsForProspect with the
 * real Anymail client (fetch mocked) and email-utils; Hunter and SnapVerify are
 * stubbed by a loader hook ("@/" aliases, and snap-contact pulls in the
 * Anthropic client, which node cannot load here).
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

const ENRICH_URL = new URL("../lib/discover/enrich-contacts.ts", import.meta.url);
const REAL: Record<string, string> = {
  "@/lib/research/anymail-finder": new URL("../lib/research/anymail-finder.ts", import.meta.url).href,
  "@/lib/research/email-utils": new URL("../lib/research/email-utils.ts", import.meta.url).href,
};

const hooks = `
const ENRICH = ${JSON.stringify(ENRICH_URL.href)};
const REAL = ${JSON.stringify(REAL)};
export async function resolve(spec, ctx, next) {
  if (ctx.parentURL === ENRICH && spec.startsWith("@/")) {
    if (spec in REAL) return { url: REAL[spec], shortCircuit: true };
    return { url: "stub:" + spec, shortCircuit: true };
  }
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url === "stub:@/lib/research/hunter") {
    return { format: "module", shortCircuit: true, source:
      "export const hunterDomainSearch = async () => (globalThis.__hunterCalls = (globalThis.__hunterCalls ?? 0) + 1, { ok: false, error: 'stub' });" };
  }
  if (url === "stub:@/lib/research/snap-contact") {
    return { format: "module", shortCircuit: true, source:
      "export const snapVerifyEnrich = async () => ({ found: false }); export const screenEmailsAgainstSmtp = async (e) => e;" };
  }
  return next(url, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hooks));

const { enrichContactsForProspect } = await import(ENRICH_URL.href);

type Row = Record<string, unknown>;

function fakeSupabase(inserts: Row[]) {
  return {
    from(table: string) {
      return {
        insert: async (row: Row) => {
          inserts.push({ table, ...row });
          return { data: null, error: null };
        },
      };
    },
  };
}

async function run(anymailBody: unknown): Promise<{ inserts: Row[]; hunterCalls: number }> {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANYMAIL_FINDER_API_KEY;
  const realWarn = console.warn;
  process.env.ANYMAIL_FINDER_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(anymailBody), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  console.warn = () => {};
  (globalThis as { __hunterCalls?: number }).__hunterCalls = 0;
  const inserts: Row[] = [];
  try {
    await enrichContactsForProspect("t1", "p1", "acme.ca", "Acme", fakeSupabase(inserts), true);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    if (realKey === undefined) delete process.env.ANYMAIL_FINDER_API_KEY;
    else process.env.ANYMAIL_FINDER_API_KEY = realKey;
  }
  return { inserts, hunterCalls: (globalThis as { __hunterCalls?: number }).__hunterCalls ?? 0 };
}

test("enrich: an Anymail-verified address is stored as anymail_verified and Hunter is skipped", async () => {
  const { inserts, hunterCalls } = await run({
    email: "henry.jonk@acme.ca",
    valid_email: "henry.jonk@acme.ca",
    email_status: "valid",
    person_full_name: "Henry Jonk",
    decision_maker_category: "ceo",
  });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0]!.table, "prospect_contacts");
  assert.equal(inserts[0]!.selected_by, "anymail_verified");
  assert.equal(inserts[0]!.email, "henry.jonk@acme.ca");
  assert.equal(hunterCalls, 0);
});

test("enrich: an unverified Anymail guess stores nothing and the waterfall moves on to Hunter", async () => {
  const { inserts, hunterCalls } = await run({ email: "henry@acme.ca", valid_email: null, email_status: "risky" });
  assert.equal(inserts.length, 0);
  assert.equal(hunterCalls, 1);
});
