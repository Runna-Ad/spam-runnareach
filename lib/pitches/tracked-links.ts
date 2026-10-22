/**
 * Tracked free-check links: every cold email (first email AND follow-ups) links
 * to OUR redirect, /r/<code>, which records a `click` event on the conversation's
 * ROOT pitch and sends the visitor on to the free check (runna-hunter) with the
 * same parameters it always got, plus &r=<code>&v=1.
 *
 * Before this, nothing told us whether anyone clicked: runna-hunter only saves a
 * row when a visitor RUNS the check.
 *
 * Safety:
 * - The destination host is the HUNTER_URL constant, never read from the
 *   request, and only the known Hunter parameters are copied across (no open
 *   redirect: `?to=`, `?host=` and anything else are dropped).
 * - An unknown or malformed code still redirects (to the free check without r).
 *   A prospect never sees a 404.
 * - Recording is best-effort and filtered: HEAD requests, link scanners and
 *   prefetchers, a repeat within 10 minutes and test addresses record nothing.
 *
 * Frozen contract (presend-learning reads it): event_type `click`, on the ROOT
 * pitch, payload `{ code, step, ua }` (step 0 = first email, 1/2 = follow-up).
 */

import { HUNTER_URL } from "./industry-templates.ts";
import { recordPitchEvent } from "./events.ts";
import { isTestAddress } from "../compliance/test-addresses.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

export const TRACKED_LINK_PATH = "/r/";

/** The Hunter parameters a tracked link carries and the redirect copies, in order. */
export const HUNTER_PARAMS = ["market", "industry", "size", "timesink", "tools", "website", "lead"] as const;

/** One value's ceiling: a longer one is dropped, not truncated (it is not ours). */
const MAX_PARAM_CHARS = 200;

/** Same alphabet and length as newAttributionCode (lib/pitches/decision.ts). */
const CODE_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;

export function isAttributionCode(code: string | null | undefined): code is string {
  return typeof code === "string" && CODE_RE.test(code);
}

/**
 * Public origin of this app: the same env vars and fallback the unsubscribe
 * link uses (lib/compliance/outbound.ts baseUrl, which isn't exported).
 */
export function trackedLinkBase(): string {
  const raw =
    process.env.UNSUBSCRIBE_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "https://spam-runnareach.vercel.app";
  return raw.replace(/\/+$/, "");
}

/**
 * `${base}/r/<code>?<hunter params>[&s=<step>]`. Step 0 (the first email) is
 * left out, so first-email links stay as short as they can.
 */
export function buildTrackedLink(args: {
  code: string;
  params: URLSearchParams;
  step?: 0 | 1 | 2;
  base?: string;
}): string {
  const out = new URLSearchParams();
  for (const name of HUNTER_PARAMS) {
    const v = args.params.get(name);
    if (v) out.set(name, v);
  }
  if (args.step) out.set("s", String(args.step));
  const query = out.toString();
  return `${args.base ?? trackedLinkBase()}${TRACKED_LINK_PATH}${args.code}${query ? `?${query}` : ""}`;
}

/**
 * Where a click on /r/<code> goes: the free check, with only the known Hunter
 * parameters copied from the request, then &r=<code> when the code is real,
 * then v=1. The host is a constant.
 */
export function hunterDestination(search: URLSearchParams, code: string | null): string {
  const out = new URLSearchParams();
  for (const name of HUNTER_PARAMS) {
    const v = search.get(name);
    if (v && v.length <= MAX_PARAM_CHARS) out.set(name, v);
  }
  if (code) out.set("r", code);
  out.set("v", "1");
  return `${HUNTER_URL}?${out.toString()}`;
}

/** step from ?s=: 1 or 2 (follow-ups), anything else 0 (the first email). */
export function stepFromParam(s: string | null): 0 | 1 | 2 {
  return s === "1" ? 1 : s === "2" ? 2 : 0;
}

/**
 * Link scanners and prefetchers open every link in an email. Substrings,
 * case-insensitive. An empty user agent counts as a scanner. Some scanners
 * (Safe Links among them) can send a normal browser UA; those get through,
 * which is why the payload keeps `ua` for an audit.
 */
export const SCANNER_UA_SUBSTRINGS = [
  "bot", "spider", "crawl", "preview", "scanner", "scan/",
  "safelinks", "safe links", "existence discovery",
  "barracuda", "proofpoint", "mimecast", "ironport", "messagelabs", "symantec",
  "forcepoint", "zscaler", "trendmicro", "trend micro", "sophos", "fortiguard",
  "headless", "phantomjs", "python", "curl/", "wget", "go-http-client", "java/",
  "okhttp", "libwww", "httpclient", "axios", "node-fetch", "undici",
  "facebookexternalhit", "whatsapp", "slackbot", "discordbot", "telegrambot",
  "googleimageproxy", "yahoomailproxy",
] as const;

export function isScannerUserAgent(ua: string | null | undefined): boolean {
  const s = (ua ?? "").trim().toLowerCase();
  if (!s) return true;
  return SCANNER_UA_SUBSTRINGS.some((needle) => s.includes(needle));
}

/** At most one recorded click per pitch per this window. */
export const CLICK_DEDUPE_MS = 10 * 60 * 1000;

export type ClickRequest = {
  code: string;
  method: string;
  userAgent: string | null;
  search: URLSearchParams;
};

export type ClickPlan = {
  /** Where to 302 the visitor. Always the free check. */
  location: string;
  /** Best-effort recording; run after the response. Never throws. */
  record: (() => Promise<ClickOutcome>) | null;
};

export type ClickOutcome =
  | "recorded"
  | "head"
  | "scanner"
  | "duplicate"
  | "test_address"
  | "recipient_unknown"
  | "error";

type RootPitch = { id: string; tenant_id: string; contact_id: string | null };

/**
 * Resolve the code to its pitch (codes live on root pitches; a child row is
 * mapped to its parent anyway), build the redirect, and return the recording
 * step separately so the route can answer before it runs.
 *
 * A lookup error still redirects WITH r (the code is well-formed; runna-hunter's
 * trigger ignores unknown refs) and records nothing.
 */
export async function planTrackedClick(supabase: AnySupabase, req: ClickRequest): Promise<ClickPlan> {
  const code = req.code.trim();
  if (!isAttributionCode(code)) return { location: hunterDestination(req.search, null), record: null };

  let root: RootPitch | null;
  try {
    const { data, error } = await supabase
      .from("pitches")
      .select("id, tenant_id, contact_id, parent_pitch_id")
      .eq("attribution_code", code)
      .limit(1)
      .maybeSingle();
    if (error) return { location: hunterDestination(req.search, code), record: null };
    root = await resolveRoot(supabase, data);
  } catch {
    return { location: hunterDestination(req.search, code), record: null };
  }
  if (!root) return { location: hunterDestination(req.search, null), record: null };

  const location = hunterDestination(req.search, code);
  const pitch = root;
  const record = async (): Promise<ClickOutcome> => {
    try {
      if (req.method.toUpperCase() !== "GET") return "head";
      if (isScannerUserAgent(req.userAgent)) return "scanner";

      // Test addresses never count. Fails closed: no contact, or an unreadable
      // one, records nothing.
      if (!pitch.contact_id) return "recipient_unknown";
      const { data: contact, error: contactErr } = await supabase
        .from("prospect_contacts")
        .select("email")
        .eq("id", pitch.contact_id)
        .maybeSingle();
      if (contactErr || !contact?.email) return "recipient_unknown";
      if (isTestAddress(contact.email as string)) return "test_address";

      const since = new Date(Date.now() - CLICK_DEDUPE_MS).toISOString();
      const { data: recent, error: recentErr } = await supabase
        .from("pitch_events")
        .select("id")
        .eq("pitch_id", pitch.id)
        .eq("event_type", "click")
        .gte("event_at", since)
        .limit(1);
      if (recentErr) return "error";
      if (Array.isArray(recent) && recent.length > 0) return "duplicate";

      await recordPitchEvent(supabase, {
        tenantId: pitch.tenant_id,
        pitchId: pitch.id,
        type: "click",
        payload: {
          code,
          step: stepFromParam(req.search.get("s")),
          ua: (req.userAgent ?? "").slice(0, 200),
        },
      });
      return "recorded";
    } catch (err) {
      console.warn("[tracked-click] not recorded:", (err as Error).message);
      return "error";
    }
  };
  return { location, record };
}

async function resolveRoot(
  supabase: AnySupabase,
  row: { id: string; tenant_id: string; contact_id: string | null; parent_pitch_id: string | null } | null,
): Promise<RootPitch | null> {
  if (!row) return null;
  if (!row.parent_pitch_id) return { id: row.id, tenant_id: row.tenant_id, contact_id: row.contact_id };
  const { data, error } = await supabase
    .from("pitches")
    .select("id, tenant_id, contact_id")
    .eq("id", row.parent_pitch_id)
    .maybeSingle();
  if (error || !data) return { id: row.id, tenant_id: row.tenant_id, contact_id: row.contact_id };
  return data as RootPitch;
}

// ── Follow-ups ─────────────────────────────────────────────────────────────

/** Our links in a stored body: a tracked /r/<code> link or a direct Hunter link. */
const STORED_LINK_RE = new RegExp(
  `(?:https?://[^\\s/]+${TRACKED_LINK_PATH}[abcdefghjkmnpqrstuvwxyz23456789]{8}|${HUNTER_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")})\\S*`,
);

/**
 * The Hunter parameters of the link the root email carried, so a follow-up
 * lands the prospect on the same pre-filled check. Null when the body holds
 * no link of ours (older pitches).
 */
export function hunterParamsFromBody(body: string | null | undefined): URLSearchParams | null {
  const m = (body ?? "").match(STORED_LINK_RE);
  if (!m) return null;
  const url = m[0].replace(/[.,;:!?)\]]+$/, "");
  try {
    const parsed = new URL(url).searchParams;
    const out = new URLSearchParams();
    for (const name of HUNTER_PARAMS) {
      const v = parsed.get(name);
      if (v) out.set(name, v);
    }
    return out.has("market") ? out : null;
  } catch {
    return null;
  }
}

/**
 * The free-check link for a follow-up: the root's tracked link with s=1|2 when
 * the root has an attribution code; the direct Hunter link (no tracking)
 * otherwise. Parameters come from the root's own link, else from `fallback`.
 */
export function followupHunterLink(args: {
  rootCode: string | null;
  followupStep: 1 | 2;
  rootBody: string | null;
  fallback: URLSearchParams;
  base?: string;
}): string {
  const params = hunterParamsFromBody(args.rootBody) ?? args.fallback;
  if (!isAttributionCode(args.rootCode)) return hunterDestination(params, null);
  return buildTrackedLink({ code: args.rootCode, params, step: args.followupStep, base: args.base });
}
