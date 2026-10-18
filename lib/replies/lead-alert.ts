/**
 * Lead alert: one email per reply-poll run listing every new prospect reply,
 * so Pedro and the sales team can act from the email alone.
 *
 * Every reply a human wrote is alerted (meeting, info, not now, wrong person,
 * opt-out, unclear), not only the ones that got a draft. Bounces and
 * out-of-office replies are left to the weekly report. Hot replies first,
 * with what the prospect actually wrote (quoted thread stripped, clipped).
 *
 * Durable: the alert is driven by the replies table, not by memory. A row is
 * sent after it is claimed (hot_alert_sent_at set, only where still null); a
 * send that reaches nobody releases the claim. The claim → send step only runs
 * with time left, so Vercel cannot kill a run between the two:
 *   - at the START of every poll run, before any thread work: every unclaimed
 *     human reply received in the last 48 hours (leftovers of earlier runs);
 *   - at the END of the run: this run's replies (and settled leftovers), only
 *     if at least 60s remain before maxDuration; otherwise nothing is claimed
 *     and the next run's start sweep sends them.
 * A row another run inserted is only swept once its classified_at is 2
 * minutes old, so the alert never goes out before that run has written the
 * draft or recorded the opt-out.
 * replies.hot_alert_sent_at now means "lead alert sent" for every human reply,
 * not only hot ones (the column predates this and was never set).
 *
 * Formatters are pure; the store is swappable: tested in tests/lead-alert.test.ts.
 */

import type { NotificationMessage, NotificationResult } from "../notify/send.ts";
import { DO_NOT_SEND_STATUSES } from "../prospects/status.ts";
import { stripQuotedReply } from "./classify.ts";
import type { ReplyIntent } from "./queries.ts";

/** How much of the prospect's own text goes in the alert. */
export const LEAD_TEXT_MAX_CHARS = 600;

export type LeadAlertItem = {
  company: string;
  fromEmail: string;
  intent: ReplyIntent;
  language: string | null;
  /** What the prospect wrote, quoted thread already stripped. */
  text: string;
  draftWaiting: boolean;
  isTest: boolean;
  /** hard_no only: the prospect is not suppressed, so the opt-out did not land. */
  optOutFailed?: boolean;
};

/** Machine replies: weekly report material, never an alert. */
export function isAlertableIntent(intent: ReplyIntent): boolean {
  return intent !== "bounced" && intent !== "auto_reply";
}

export function intentLabel(intent: ReplyIntent, optOutFailed = false): string {
  switch (intent) {
    case "wants_meeting":
      return "wants a meeting";
    case "wants_info":
      return "wants more info";
    case "not_now":
      return "not now";
    case "wrong_person":
      return "wrong person";
    case "hard_no":
      return optOutFailed ? "opted out: removal NOT confirmed, check by hand" : "opted out: removed automatically";
    case "bounced":
      return "bounced";
    case "auto_reply":
      return "auto-reply";
    case "unclassified":
      return "unclear";
  }
}

const RANK: Partial<Record<ReplyIntent, number>> = { wants_meeting: 0, wants_info: 1 };

/** wants_meeting, then wants_info, then the rest; arrival order within each. */
export function sortLeadItems(items: LeadAlertItem[]): LeadAlertItem[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (RANK[a.item.intent] ?? 2) - (RANK[b.item.intent] ?? 2) || a.i - b.i)
    .map((x) => x.item);
}

/** Clip to `max` characters (whole text kept verbatim when it fits). */
export function clipText(text: string, max = LEAD_TEXT_MAX_CHARS): string {
  const t = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).trimEnd()}…`;
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "https://spam-runnareach.vercel.app";
}

function itemBlock(item: LeadAlertItem, n: number | null): string {
  const head = `${n === null ? "" : `${n}. `}${item.company}: ${intentLabel(item.intent, item.optOutFailed)}${item.isTest ? " [test]" : ""}`;
  const meta = [
    `From: ${item.fromEmail}`,
    `Prospect language: ${(item.language ?? "unknown").toUpperCase()}`,
    item.draftWaiting ? "Draft reply waiting for review" : "No draft",
  ].join(" · ");
  const text = clipText(item.text);
  const quoted = text ? text.split("\n").map((l) => `   > ${l}`).join("\n") : "   (no text)";
  return `${head}\n   ${meta}\n   They wrote:\n${quoted}`;
}

/** Subject + body for one run's new replies; null when there is nothing to alert. */
export function formatLeadAlert(items: LeadAlertItem[]): { subject: string; body: string } | null {
  const sorted = sortLeadItems(items.filter((i) => isAlertableIntent(i.intent)));
  const first = sorted[0];
  if (!first) return null;
  const link = `${appUrl()}/inbox`;

  if (sorted.length === 1) {
    return {
      subject: `${first.isTest ? "[test] " : ""}Reply from ${first.company}: ${intentLabel(first.intent, first.optOutFailed)}`,
      body: `${itemBlock(first, null)}\n\nOpen the inbox: ${link}`,
    };
  }

  // Test replies never count as real interest (core rule 7).
  const meetings = sorted.filter((i) => i.intent === "wants_meeting" && !i.isTest).length;
  const allTest = sorted.every((i) => i.isTest);
  return {
    subject: `${allTest ? "[test] " : ""}${sorted.length} new replies (${meetings} want${meetings === 1 ? "s" : ""} a meeting)`,
    body: `${sorted.map((item, i) => itemBlock(item, i + 1)).join("\n\n")}\n\nOpen the inbox: ${link}`,
  };
}

// ── Durable send: claim unalerted reply rows, send, release on total failure ──

/** Replies older than this are never alerted (keeps history out of the inbox). */
export const LEAD_ALERT_WINDOW_HOURS = 48;
const LEAD_ALERT_BATCH = 100;

/** Another run's reply is swept only once it is this old (its draft / opt-out are written). */
export const LEAD_ALERT_SETTLE_MS = 2 * 60_000;

export type PendingLeadReply = { id: string; tenantId: string; classifiedAt: string | null; item: LeadAlertItem };

export type LeadAlertStore = {
  /** Human replies (not bounced / auto_reply) received since `sinceIso`, hot_alert_sent_at null. */
  pending(sinceIso: string): Promise<PendingLeadReply[]>;
  /** Sets hot_alert_sent_at where still null; returns the ids this caller won. */
  claim(ids: string[]): Promise<string[]>;
  /** Clears hot_alert_sent_at so the next run retries. */
  release(ids: string[]): Promise<void>;
};

export type LeadReplyRow = {
  id: string;
  tenant_id: string;
  from_email: string;
  intent: ReplyIntent;
  body_text: string | null;
  draft_status: string | null;
  classified_at: string | null;
  prospects: { company_name: string | null; language: string | null; status: string | null } | null;
};

/** One alert line from a stored reply row. */
export function leadItemFromRow(row: LeadReplyRow, isTest: (email: string) => boolean): LeadAlertItem {
  const p = row.prospects;
  return {
    company: p?.company_name ?? row.from_email,
    fromEmail: row.from_email,
    intent: row.intent,
    language: p?.language ?? null,
    text: stripQuotedReply(row.body_text) || (row.body_text ?? ""),
    draftWaiting: row.draft_status === "pending",
    isTest: isTest(row.from_email),
    // Stopped = any do-not-send status (lib/prospects/status.ts): a booked/won/lost
    // prospect who opts out keeps that status by design, and DNC + pause still apply.
    optOutFailed: row.intent === "hard_no" && !DO_NOT_SEND_STATUSES.has(p?.status ?? ""),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function supabaseLeadAlertStore(db: any, isTest: (email: string) => boolean): LeadAlertStore {
  return {
    async pending(sinceIso) {
      const { data, error } = await db
        .from("replies")
        .select("id, tenant_id, from_email, intent, body_text, draft_status, classified_at, prospects(company_name, language, status)")
        .is("hot_alert_sent_at", null)
        .not("intent", "in", "(bounced,auto_reply)")
        .gte("received_at", sinceIso)
        .order("received_at", { ascending: true })
        .limit(LEAD_ALERT_BATCH);
      if (error) throw new Error(`lead alert lookup failed: ${error.message}`);
      return ((data ?? []) as LeadReplyRow[]).map((r) => ({
        id: r.id, tenantId: r.tenant_id, classifiedAt: r.classified_at, item: leadItemFromRow(r, isTest),
      }));
    },
    async claim(ids) {
      if (ids.length === 0) return [];
      const { data, error } = await db
        .from("replies")
        .update({ hot_alert_sent_at: new Date().toISOString() })
        .in("id", ids)
        .is("hot_alert_sent_at", null)
        .select("id");
      if (error) throw new Error(`lead alert claim failed: ${error.message}`);
      return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    },
    async release(ids) {
      if (ids.length === 0) return;
      const { error } = await db.from("replies").update({ hot_alert_sent_at: null }).in("id", ids);
      if (error) throw new Error(`lead alert release failed: ${error.message}`);
    },
  };
}

export type TenantLeadSender = (tenantId: string, message: NotificationMessage) => Promise<NotificationResult>;

export type LeadAlertRunOptions = {
  /** Epoch ms after which nothing is claimed (rows stay for the next run). */
  deadline?: number;
  /** Replies this run inserted: claimed without waiting for them to settle. */
  ownIds?: ReadonlySet<string>;
  clock?: () => number;
};

/**
 * One lead alert per tenant for every unalerted human reply in the window.
 * Partial delivery keeps the claim (no duplicate to those who got it); zero
 * delivery releases it for the next run. Never throws.
 */
export async function sendPendingLeadAlerts(
  store: LeadAlertStore,
  send: TenantLeadSender,
  opts: LeadAlertRunOptions = {},
): Promise<NotificationResult> {
  const clock = opts.clock ?? Date.now;
  const total: NotificationResult = { sent: 0, failed: [] };
  if (opts.deadline !== undefined && clock() > opts.deadline) return total;
  let pending: PendingLeadReply[];
  try {
    pending = await store.pending(new Date(clock() - LEAD_ALERT_WINDOW_HOURS * 3_600_000).toISOString());
  } catch (err) {
    total.failed.push((err as Error).message);
    return total;
  }
  const settledBefore = clock() - LEAD_ALERT_SETTLE_MS;
  pending = pending.filter(
    (p) => opts.ownIds?.has(p.id) || (p.classifiedAt !== null && Date.parse(p.classifiedAt) <= settledBefore),
  );

  const byTenant = new Map<string, PendingLeadReply[]>();
  for (const p of pending) byTenant.set(p.tenantId, [...(byTenant.get(p.tenantId) ?? []), p]);

  for (const [tenantId, rows] of byTenant) {
    // Never claim what this run may not have time to send.
    if (opts.deadline !== undefined && clock() > opts.deadline) break;
    let claimed: string[] = [];
    try {
      claimed = await store.claim(rows.map((r) => r.id));
      const won = new Set(claimed);
      const alert = formatLeadAlert(rows.filter((r) => won.has(r.id)).map((r) => r.item));
      if (!alert) continue;
      const res = await send(tenantId, { kind: "lead", fromName: "S.P.A.M Leads", ...alert });
      total.sent += res.sent;
      total.failed.push(...res.failed);
      if (res.sent === 0) await store.release(claimed);
    } catch (err) {
      total.failed.push(`tenant ${tenantId}: ${(err as Error).message}`);
      if (claimed.length > 0) await store.release(claimed).catch(() => {});
    }
  }
  return total;
}
