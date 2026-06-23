// ─────────────────────────────────────────────────────────────────────────────
// lib/warmup/deliverability.ts
// Low-volume deliverability signals that work from email #1 — complements
// Google Postmaster (which needs high volume + many distinct recipients before
// it shows anything). Pure DNS lookups: SPF / DKIM / DMARC record health +
// domain blocklist status. No API keys, no volume needed.
//
// NOTE: mail is sent via Gmail/Workspace, so the *sending IP* is Google's
// (clean, not blocklistable by us) — IP blocklists don't apply. We check
// DOMAIN-based blocklists (dbl.spamhaus.org, multi.surbl.org), which flag a
// domain reputation problem.
// ─────────────────────────────────────────────────────────────────────────────

import { Resolver } from "node:dns/promises";

export type CheckStatus = "pass" | "warn" | "fail" | "unknown";

export type DeliverabilityHealth = {
  domain: string;
  checked_at: string;
  spf: { status: CheckStatus; detail: string };
  dkim: { status: CheckStatus; detail: string };
  dmarc: { status: CheckStatus; detail: string; policy: string | null };
  blocklist: { status: CheckStatus; detail: string; listed_on: string[] };
};

// Google Workspace publishes DKIM under the "google" selector by default.
const DKIM_SELECTOR = "google";
// Domain-reputation blocklists (domain-based, not IP).
const DOMAIN_BLOCKLISTS = ["dbl.spamhaus.org", "multi.surbl.org"];

function resolver(): Resolver {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  // Public resolvers — avoid depending on the platform's default DNS.
  r.setServers(["8.8.8.8", "1.1.1.1"]);
  return r;
}

async function txt(name: string): Promise<string[]> {
  try {
    const records = await resolver().resolveTxt(name);
    // Each record is an array of string chunks — join them.
    return records.map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
}

async function checkSpf(domain: string): Promise<DeliverabilityHealth["spf"]> {
  const records = (await txt(domain)).filter((r) => r.toLowerCase().startsWith("v=spf1"));
  if (records.length === 0) {
    return { status: "fail", detail: "No SPF record found" };
  }
  if (records.length > 1) {
    return { status: "fail", detail: "Multiple SPF records (must be exactly one)" };
  }
  const rec = records[0]!;
  const includesGoogle = /_spf\.google\.com/i.test(rec);
  if (!includesGoogle) {
    return { status: "warn", detail: "SPF present but missing include:_spf.google.com (you send via Gmail)" };
  }
  return { status: "pass", detail: "SPF present and authorizes Google" };
}

async function checkDkim(domain: string): Promise<DeliverabilityHealth["dkim"]> {
  const name = `${DKIM_SELECTOR}._domainkey.${domain}`;
  const records = await txt(name);
  const dkim = records.find((r) => /v=DKIM1|k=rsa|p=/i.test(r));
  if (!dkim) {
    return { status: "fail", detail: `No DKIM record at ${DKIM_SELECTOR}._domainkey (check Workspace DKIM is turned on)` };
  }
  // A revoked key publishes an empty p= value.
  if (/p=\s*(;|$)/i.test(dkim)) {
    return { status: "fail", detail: "DKIM record present but public key is empty (revoked)" };
  }
  return { status: "pass", detail: `DKIM present (selector: ${DKIM_SELECTOR})` };
}

async function checkDmarc(domain: string): Promise<DeliverabilityHealth["dmarc"]> {
  const records = (await txt(`_dmarc.${domain}`)).filter((r) => /v=DMARC1/i.test(r));
  if (records.length === 0) {
    return { status: "fail", detail: "No DMARC record found", policy: null };
  }
  const rec = records[0]!;
  const policy = /p=\s*(none|quarantine|reject)/i.exec(rec)?.[1]?.toLowerCase() ?? null;
  const hasRua = /rua=/i.test(rec);
  if (policy === "none") {
    return {
      status: "warn",
      detail: hasRua
        ? "DMARC p=none (monitoring only — fine while warming; tighten to quarantine later)"
        : "DMARC p=none and no rua= (add a report address to get aggregate reports)",
      policy,
    };
  }
  if (policy === "quarantine" || policy === "reject") {
    return { status: "pass", detail: `DMARC enforced (p=${policy})`, policy };
  }
  return { status: "warn", detail: "DMARC record present but policy unclear", policy };
}

async function checkBlocklists(domain: string): Promise<DeliverabilityHealth["blocklist"]> {
  const r = resolver();
  const listedOn: string[] = [];
  await Promise.all(
    DOMAIN_BLOCKLISTS.map(async (bl) => {
      try {
        // A hit resolves to a 127.0.0.x address; a miss is NXDOMAIN (throws).
        const res = await r.resolve4(`${domain}.${bl}`);
        if (res.some((ip) => ip.startsWith("127."))) listedOn.push(bl);
      } catch {
        // NXDOMAIN / no answer = not listed.
      }
    }),
  );
  if (listedOn.length > 0) {
    return { status: "fail", detail: `Domain listed on ${listedOn.join(", ")}`, listed_on: listedOn };
  }
  return { status: "pass", detail: "Not on Spamhaus DBL / SURBL", listed_on: [] };
}

/** Run all low-volume deliverability checks for a sending domain. Pure DNS. */
export async function checkDeliverabilityHealth(domain: string): Promise<DeliverabilityHealth> {
  const [spf, dkim, dmarc, blocklist] = await Promise.all([
    checkSpf(domain),
    checkDkim(domain),
    checkDmarc(domain),
    checkBlocklists(domain),
  ]);
  return { domain, checked_at: new Date().toISOString(), spf, dkim, dmarc, blocklist };
}
