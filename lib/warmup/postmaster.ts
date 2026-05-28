// ─────────────────────────────────────────────────────────────────────────────
// lib/warmup/postmaster.ts
// Google Postmaster Tools API v1 client.
//
// Fetches domain reputation, spam rate, SPF/DKIM/DMARC ratios.
// Requires the sending account's Gmail OAuth token to have the
// `https://www.googleapis.com/auth/postmaster.readonly` scope.
//
// Called from the Supabase Edge Function (daily cron) and the warmup dashboard.
// ─────────────────────────────────────────────────────────────────────────────

const POSTMASTER_BASE = "https://gmailpostmastertools.googleapis.com/v1";

export type PostmasterDomainStats = {
  domain: string;
  date: string; // YYYY-MM-DD
  domainReputation:
    | "HIGH"
    | "MEDIUM"
    | "LOW"
    | "BAD"
    | "REPUTATION_CATEGORY_UNSPECIFIED"
    | null;
  userReportedSpamRatio: number | null;
  ipReputation:
    | "HIGH"
    | "MEDIUM"
    | "LOW"
    | "BAD"
    | "REPUTATION_CATEGORY_UNSPECIFIED"
    | null;
  spfSuccessRatio: number | null;
  dkimSuccessRatio: number | null;
  dmarcSuccessRatio: number | null;
  inboundEncryptionRatio: number | null;
  raw: unknown;
};

// ── Fetch domain stats for today (or the most recent available date) ───────────

export async function fetchDomainStats(
  accessToken: string,
  domain: string,
): Promise<PostmasterDomainStats | null> {
  try {
    // List the domain's traffic stats — the API returns a list ordered desc by date
    const url =
      `${POSTMASTER_BASE}/domains/${encodeURIComponent(domain)}/trafficStats` +
      `?pageSize=1`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[postmaster] fetchDomainStats HTTP ${res.status}: ${body}`);
      return null;
    }

    const json = (await res.json()) as {
      trafficStats?: Array<{
        name?: string;
        userReportedSpamRatio?: number;
        domainReputation?: string;
        ipReputation?: string;
        spfSuccessRatio?: number;
        dkimSuccessRatio?: number;
        dmarcSuccessRatio?: number;
        inboundEncryptionRatio?: number;
      }>;
    };

    if (!json.trafficStats || json.trafficStats.length === 0) {
      // No data yet — domain may be new or not registered with Postmaster
      return null;
    }

    const stat = json.trafficStats[0];
    if (!stat) return null;

    // The "name" is like "domains/example.com/trafficStats/20240115"
    const datePart = stat.name?.split("/").pop() ?? "";
    const dateStr =
      datePart.length === 8
        ? `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`
        : (new Date().toISOString().split("T")[0] as string);

    return {
      domain,
      date: dateStr,
      domainReputation: (stat.domainReputation as PostmasterDomainStats["domainReputation"]) ?? null,
      userReportedSpamRatio: stat.userReportedSpamRatio ?? null,
      ipReputation: (stat.ipReputation as PostmasterDomainStats["ipReputation"]) ?? null,
      spfSuccessRatio: stat.spfSuccessRatio ?? null,
      dkimSuccessRatio: stat.dkimSuccessRatio ?? null,
      dmarcSuccessRatio: stat.dmarcSuccessRatio ?? null,
      inboundEncryptionRatio: stat.inboundEncryptionRatio ?? null,
      raw: stat,
    };
  } catch (err) {
    console.error("[postmaster] fetchDomainStats error:", err);
    return null;
  }
}

// ── List registered domains for this account ──────────────────────────────────

export async function listPostmasterDomains(
  accessToken: string,
): Promise<string[]> {
  try {
    const res = await fetch(`${POSTMASTER_BASE}/domains`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) return [];

    const json = (await res.json()) as {
      domains?: Array<{ name?: string }>;
    };

    return (json.domains ?? [])
      .map((d) => d.name?.replace("domains/", "") ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}
