/**
 * Lead alert: one email per reply-poll run listing every new prospect reply,
 * so Pedro and the sales team can act from the email alone.
 *
 * Every reply a human wrote is alerted (meeting, info, not now, wrong person,
 * opt-out, unclear), not only the ones that got a draft. Bounces and
 * out-of-office replies are left to the weekly report. Hot replies first,
 * with what the prospect actually wrote (quoted thread stripped, clipped).
 *
 * The poll inserts each reply row once (duplicates never reach the collector),
 * so a reply is alerted at most once.
 *
 * Pure apart from the injected sender: tested in tests/lead-alert.test.ts.
 */

import type { NotificationMessage, NotificationResult } from "../notify/send.ts";
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
  /** hard_no only: recording the opt-out failed, so nobody removed them. */
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
      return optOutFailed ? "opted out: automatic removal FAILED, remove by hand" : "opted out: removed automatically";
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
    `Language: ${(item.language ?? "unknown").toUpperCase()}`,
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

  const meetings = sorted.filter((i) => i.intent === "wants_meeting").length;
  return {
    subject: `${sorted.length} new replies (${meetings} want${meetings === 1 ? "s" : ""} a meeting)`,
    body: `${sorted.map((item, i) => itemBlock(item, i + 1)).join("\n\n")}\n\nOpen the inbox: ${link}`,
  };
}

// ── Collect during a poll run, send once at the end ──────────────────────────

export type LeadSender = (message: NotificationMessage) => Promise<NotificationResult>;

/**
 * Per tenant: the replies stored this run and a sender for that tenant (the
 * inbox that read the thread). `send` mails each tenant's alert once and never
 * throws: an alert failure must not break the poll.
 */
export class LeadAlertCollector {
  private readonly groups = new Map<string, { send: LeadSender; items: LeadAlertItem[] }>();

  add(tenantId: string, send: LeadSender, item: LeadAlertItem): void {
    if (!isAlertableIntent(item.intent)) return;
    const group = this.groups.get(tenantId) ?? { send, items: [] };
    group.items.push(item);
    this.groups.set(tenantId, group);
  }

  get size(): number {
    let n = 0;
    for (const g of this.groups.values()) n += g.items.length;
    return n;
  }

  async send(): Promise<NotificationResult> {
    const total: NotificationResult = { sent: 0, failed: [] };
    for (const [tenantId, group] of this.groups) {
      const alert = formatLeadAlert(group.items);
      if (!alert) continue;
      try {
        const res = await group.send({ kind: "lead", fromName: "S.P.A.M Leads", ...alert });
        total.sent += res.sent;
        total.failed.push(...res.failed);
      } catch (err) {
        total.failed.push(`tenant ${tenantId}: ${(err as Error).message}`);
      }
    }
    return total;
  }
}
