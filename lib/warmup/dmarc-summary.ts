// ─────────────────────────────────────────────────────────────────────────────
// lib/warmup/dmarc-summary.ts
//
// Read-side aggregation of stored DMARC aggregate-report records into the
// summary surfaced on the warmup dashboard's Deliverability Health card.
//
// Two distinct low-volume abuse signals (Pedro's call — show both separately):
//   1. failed_alignment — source IPs that sent AS our domain but failed BOTH
//      SPF and DKIM alignment. Catches spoofing/forwarding regardless of who.
//   2. non_google      — source IPs not inside Google's published SPF ranges.
//      We send via Gmail/Workspace, so any non-Google sender is "not us".
//
// Google's ranges are resolved live from _spf.google.com (module-cached) so we
// never hand-maintain a CIDR list that drifts.
// ─────────────────────────────────────────────────────────────────────────────

import { Resolver } from "node:dns/promises";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

export type DmarcSourceFlag = {
  source_ip: string;
  message_count: number;
  /** Most recent header_from seen for this IP. */
  header_from: string | null;
  dkim_aligned: boolean | null;
  spf_aligned: boolean | null;
};

export type DmarcSummary = {
  window_days: number;
  reports: number;
  /** Total messages reported across all sources in the window. */
  total_messages: number;
  /** Messages that passed DMARC alignment (DKIM or SPF aligned-pass). */
  aligned_pass_messages: number;
  /** aligned_pass_messages / total_messages, 0..1. */
  pass_rate: number | null;
  /** Most recent report end date (ISO) we have, for "last updated". */
  latest_report_end: string | null;
  /** Sources that failed BOTH SPF and DKIM alignment (possible spoofing). */
  failed_alignment: DmarcSourceFlag[];
  /** Sources outside Google's published SPF ranges (not our authorized sender). */
  non_google: DmarcSourceFlag[];
};

type RecordRow = {
  source_ip: string | null;
  message_count: number | null;
  dkim_eval: string | null;
  spf_eval: string | null;
  dkim_aligned: boolean | null;
  spf_aligned: boolean | null;
  dmarc_pass: boolean | null;
  header_from: string | null;
};

// ── Google SPF range resolution (cached) ────────────────────────────────────────

type Cidr = { base: bigint; bits: number; v6: boolean };
let googleCidrCache: { cidrs: Cidr[]; at: number } | null = null;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function resolver(): Resolver {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  r.setServers(["8.8.8.8", "1.1.1.1"]);
  return r;
}

async function txt(name: string): Promise<string[]> {
  try {
    return (await resolver().resolveTxt(name)).map((c) => c.join(""));
  } catch {
    return [];
  }
}

/** Recursively expand an SPF record's include: / ip4: / ip6: into CIDRs. */
async function expandSpf(domain: string, seen: Set<string>, out: Cidr[]): Promise<void> {
  if (seen.has(domain) || seen.size > 30) return;
  seen.add(domain);
  const records = (await txt(domain)).filter((r) => r.toLowerCase().startsWith("v=spf1"));
  for (const rec of records) {
    for (const token of rec.split(/\s+/)) {
      const t = token.toLowerCase();
      if (t.startsWith("include:")) {
        await expandSpf(token.slice(8), seen, out);
      } else if (t.startsWith("ip4:")) {
        const c = parseCidr(token.slice(4), false);
        if (c) out.push(c);
      } else if (t.startsWith("ip6:")) {
        const c = parseCidr(token.slice(4), true);
        if (c) out.push(c);
      }
    }
  }
}

async function googleCidrs(): Promise<Cidr[]> {
  if (googleCidrCache && Date.now() - googleCidrCache.at < CACHE_TTL_MS) {
    return googleCidrCache.cidrs;
  }
  const out: Cidr[] = [];
  await expandSpf("_spf.google.com", new Set(), out);
  googleCidrCache = { cidrs: out, at: Date.now() };
  return out;
}

function parseCidr(raw: string, v6: boolean): Cidr | null {
  const [addr, bitsRaw] = raw.split("/");
  if (!addr) return null;
  const ip = ipToBigInt(addr, v6);
  if (ip === null) return null;
  const bits = bitsRaw !== undefined ? Number(bitsRaw) : v6 ? 128 : 32;
  if (!Number.isFinite(bits)) return null;
  return { base: ip, bits, v6 };
}

function ipToBigInt(addr: string, v6: boolean): bigint | null {
  try {
    if (!v6) {
      const parts = addr.split(".").map(Number);
      if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
      return parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n);
    }
    // IPv6 — expand "::" then parse 8 hextets.
    const dbl = addr.split("::");
    let head: string[] = dbl[0] ? dbl[0].split(":") : [];
    const tail: string[] = dbl.length > 1 && dbl[1] ? dbl[1].split(":") : [];
    if (dbl.length > 1) {
      const fill = 8 - head.length - tail.length;
      head = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail];
    }
    const hextets = head.length === 8 ? head : null;
    if (!hextets) return null;
    return hextets.reduce((acc, h) => (acc << 16n) | BigInt(parseInt(h || "0", 16)), 0n);
  } catch {
    return null;
  }
}

function ipInCidrs(ipRaw: string, cidrs: Cidr[]): boolean {
  const v6 = ipRaw.includes(":");
  const ip = ipToBigInt(ipRaw, v6);
  if (ip === null) return false;
  for (const c of cidrs) {
    if (c.v6 !== v6) continue;
    const total = c.v6 ? 128 : 32;
    const shift = BigInt(total - c.bits);
    if (shift < 0n) continue;
    if (ip >> shift === c.base >> shift) return true;
  }
  return false;
}

// ── Summary builder ─────────────────────────────────────────────────────────────

export async function getDmarcSummary(
  supabase: AnySupabase,
  tenantId: string,
  domain: string,
  windowDays = 14,
): Promise<DmarcSummary | null> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  // Pull reports in window for this policy domain.
  const { data: reports } = await supabase
    .from("dmarc_reports")
    .select("id, date_range_end")
    .eq("tenant_id", tenantId)
    .eq("policy_domain", domain)
    .gte("date_range_end", since)
    .order("date_range_end", { ascending: false })
    .limit(500);

  const reportIds: string[] = (reports ?? []).map((r: { id: string }) => r.id);
  if (reportIds.length === 0) {
    return {
      window_days: windowDays,
      reports: 0,
      total_messages: 0,
      aligned_pass_messages: 0,
      pass_rate: null,
      latest_report_end: null,
      failed_alignment: [],
      non_google: [],
    };
  }

  const { data: records } = await supabase
    .from("dmarc_report_records")
    .select(
      "source_ip, message_count, dkim_eval, spf_eval, dkim_aligned, spf_aligned, dmarc_pass, header_from",
    )
    .in("report_fk", reportIds)
    .limit(5000);

  const rows: RecordRow[] = records ?? [];

  let total = 0;
  let alignedPass = 0;
  // Aggregate by source IP for the two flag lists.
  const failedByIp = new Map<string, DmarcSourceFlag>();
  const allByIp = new Map<string, DmarcSourceFlag>();

  for (const r of rows) {
    const count = r.message_count ?? 0;
    total += count;
    if (r.dmarc_pass) alignedPass += count;

    const ip = r.source_ip;
    if (!ip) continue;

    const agg = allByIp.get(ip) ?? {
      source_ip: ip,
      message_count: 0,
      header_from: r.header_from,
      dkim_aligned: r.dkim_aligned,
      spf_aligned: r.spf_aligned,
    };
    agg.message_count += count;
    if (r.header_from) agg.header_from = r.header_from;
    allByIp.set(ip, agg);

    // Failed BOTH alignments → possible spoofing.
    const failedBoth = r.dkim_eval !== "pass" && r.spf_eval !== "pass";
    if (failedBoth) {
      const f = failedByIp.get(ip) ?? {
        source_ip: ip,
        message_count: 0,
        header_from: r.header_from,
        dkim_aligned: r.dkim_aligned,
        spf_aligned: r.spf_aligned,
      };
      f.message_count += count;
      if (r.header_from) f.header_from = r.header_from;
      failedByIp.set(ip, f);
    }
  }

  // Non-Google: any source IP outside Google's published SPF ranges.
  const cidrs = await googleCidrs().catch(() => [] as Cidr[]);
  const nonGoogle: DmarcSourceFlag[] = [];
  // If we couldn't resolve Google's ranges, skip this list (don't false-flag).
  if (cidrs.length > 0) {
    for (const agg of allByIp.values()) {
      if (!ipInCidrs(agg.source_ip, cidrs)) nonGoogle.push(agg);
    }
  }

  const sortDesc = (a: DmarcSourceFlag, b: DmarcSourceFlag) => b.message_count - a.message_count;

  return {
    window_days: windowDays,
    reports: reportIds.length,
    total_messages: total,
    aligned_pass_messages: alignedPass,
    pass_rate: total > 0 ? alignedPass / total : null,
    latest_report_end: (reports?.[0]?.date_range_end as string | undefined) ?? null,
    failed_alignment: [...failedByIp.values()].sort(sortDesc).slice(0, 10),
    non_google: nonGoogle.sort(sortDesc).slice(0, 10),
  };
}
