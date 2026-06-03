/**
 * verify-email — Supabase Edge Function (Deno runtime)
 *
 * Accepts: POST { emails: string[], domain: string }
 * Returns: { results: EmailVerifyResult[], provider: string, is_catch_all: boolean, port25_blocked: boolean }
 *
 * Steps:
 *  1. MX record lookup via Deno.resolveDns
 *  2. Identify email provider (google / microsoft / yahoo / zoho / unknown)
 *  3. Catch-all probe: attempt SMTP RCPT TO for a fake address
 *  4. Per-email SMTP verification (skipped if catch-all or port 25 blocked)
 *
 * Port 25 is often blocked on Supabase / AWS infrastructure. The function
 * gracefully degrades: if the TCP connect throws, it returns port25_blocked=true
 * so the caller (snap-contact.ts) can fall back to the Google Workspace heuristic.
 *
 * No JWT required (verify_jwt: false in supabase/config.toml) — this is an
 * internal enrichment tool called server-side only.
 */

// @ts-expect-error — Deno edge runtime types
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

type VerifyRequest = {
  emails: string[];
  domain: string;
};

type EmailVerifyResult = {
  email: string;
  smtp_code: number | null;
  verdict: "valid" | "invalid" | "unknown" | "catch_all";
  confidence: number; // 0–100
};

type VerifyResponse = {
  results: EmailVerifyResult[];
  provider: string;
  is_catch_all: boolean;
  port25_blocked: boolean;
  mx_host: string | null;
  error?: string;
};

// ── Provider detection from MX hostnames ─────────────────────────────────────

const PROVIDER_PATTERNS: [RegExp, string][] = [
  [/google\.com|googlemail\.com|gmail\.com/i, "google"],
  [/outlook\.com|hotmail\.com|microsoft\.com|protection\.outlook/i, "microsoft"],
  [/yahoo\.com|yahoodns\.net/i, "yahoo"],
  [/zoho\.com/i, "zoho"],
  [/protonmail\.ch|proton\.me/i, "proton"],
  [/mxroute\.|emailsrvr\.|rackspace\./i, "rackspace"],
];

function detectProvider(mxHosts: string[]): string {
  for (const host of mxHosts) {
    for (const [pattern, name] of PROVIDER_PATTERNS) {
      if (pattern.test(host)) return name;
    }
  }
  return "unknown";
}

// ── SMTP probe via raw TCP (port 25) ─────────────────────────────────────────

const SMTP_TIMEOUT_MS = 8_000;
const SENDER = "probe@verify.runnareach.com";

async function smtpProbe(
  mxHost: string,
  email: string,
): Promise<{ code: number | null; blocked: boolean }> {
  let conn: Deno.TcpConn | null = null;
  try {
    const connectPromise = Deno.connect({ hostname: mxHost, port: 25 });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("connect timeout")), SMTP_TIMEOUT_MS),
    );
    conn = await Promise.race([connectPromise, timeoutPromise]) as Deno.TcpConn;

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const buf = new Uint8Array(1024);

    const readLine = async (): Promise<string> => {
      const n = await conn!.read(buf);
      return decoder.decode(buf.subarray(0, n ?? 0));
    };

    // Greeting
    await readLine();
    // EHLO
    await conn.write(encoder.encode(`EHLO verify.runnareach.com\r\n`));
    await readLine();
    // MAIL FROM
    await conn.write(encoder.encode(`MAIL FROM:<${SENDER}>\r\n`));
    await readLine();
    // RCPT TO
    await conn.write(encoder.encode(`RCPT TO:<${email}>\r\n`));
    const rcptResponse = await readLine();
    const code = parseInt(rcptResponse.trim().slice(0, 3), 10);
    // QUIT
    try {
      await conn.write(encoder.encode(`QUIT\r\n`));
    } catch {
      // ignore quit errors
    }
    return { code: isNaN(code) ? null : code, blocked: false };
  } catch (err) {
    const msg = (err as Error).message ?? "";
    // Port blocked → connection refused / timeout
    if (
      msg.includes("connect") ||
      msg.includes("timeout") ||
      msg.includes("refused") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("OS error")
    ) {
      return { code: null, blocked: true };
    }
    return { code: null, blocked: false };
  } finally {
    try {
      conn?.close();
    } catch {
      // ignore
    }
  }
}

// ── Catch-all detection ───────────────────────────────────────────────────────

async function detectCatchAll(
  mxHost: string,
  domain: string,
): Promise<{ isCatchAll: boolean; blocked: boolean }> {
  // Use a clearly fake address that no real domain would have
  const fakeEmail = `__catch_all_probe_xqz9__@${domain}`;
  const { code, blocked } = await smtpProbe(mxHost, fakeEmail);
  if (blocked) return { isCatchAll: false, blocked: true };
  // 250 = accepted → catch-all
  return { isCatchAll: code === 250, blocked: false };
}

// ── Main handler ──────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const body: VerifyRequest = await req.json();
    const { emails, domain } = body;

    if (!domain || !Array.isArray(emails) || emails.length === 0) {
      return Response.json(
        { error: "Missing required fields: emails[], domain" },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    // ── Step 1: MX lookup ─────────────────────────────────────────────────
    let mxHosts: string[] = [];
    let mxHost: string | null = null;
    try {
      const records = await Deno.resolveDns(domain, "MX");
      // Sort by priority (lowest = highest priority)
      records.sort((a, b) => a.preference - b.preference);
      mxHosts = records.map((r) => r.exchange.replace(/\.$/, ""));
      mxHost = mxHosts[0] ?? null;
    } catch {
      // DNS failure — domain might not exist
      return Response.json(
        {
          results: emails.map((email) => ({
            email,
            smtp_code: null,
            verdict: "unknown" as const,
            confidence: 0,
          })),
          provider: "unknown",
          is_catch_all: false,
          port25_blocked: false,
          mx_host: null,
          error: "MX lookup failed",
        } satisfies VerifyResponse,
        { headers: CORS_HEADERS },
      );
    }

    // ── Step 2: Provider detection ────────────────────────────────────────
    const provider = detectProvider(mxHosts);

    // ── Step 3: Catch-all detection ───────────────────────────────────────
    let isCatchAll = false;
    let port25Blocked = false;

    if (mxHost) {
      const catchAllResult = await detectCatchAll(mxHost, domain);
      isCatchAll = catchAllResult.isCatchAll;
      port25Blocked = catchAllResult.blocked;
    }

    // ── Step 4: Per-email verification ────────────────────────────────────
    const results: EmailVerifyResult[] = [];

    if (port25Blocked || isCatchAll || !mxHost) {
      // Can't SMTP-verify — return unknown for all
      for (const email of emails) {
        results.push({
          email,
          smtp_code: null,
          verdict: isCatchAll ? "catch_all" : "unknown",
          confidence: isCatchAll ? 30 : 0,
        });
      }
    } else {
      // SMTP verify each email
      for (const email of emails) {
        const { code, blocked } = await smtpProbe(mxHost, email);
        if (blocked) {
          port25Blocked = true;
          results.push({ email, smtp_code: null, verdict: "unknown", confidence: 0 });
        } else if (code === 250) {
          results.push({ email, smtp_code: 250, verdict: "valid", confidence: 90 });
        } else if (code === 550 || code === 551 || code === 553) {
          results.push({ email, smtp_code: code, verdict: "invalid", confidence: 85 });
        } else {
          results.push({ email, smtp_code: code, verdict: "unknown", confidence: 20 });
        }
      }
    }

    const response: VerifyResponse = {
      results,
      provider,
      is_catch_all: isCatchAll,
      port25_blocked: port25Blocked,
      mx_host: mxHost,
    };

    return Response.json(response, { headers: CORS_HEADERS });
  } catch (err) {
    return Response.json(
      { error: (err as Error).message ?? "Unknown error" },
      { status: 500, headers: CORS_HEADERS },
    );
  }
});
