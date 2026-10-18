/**
 * Hold endpoint — the target of each line's "Hold" link in the veto digest.
 * Public: no login, authorised only by the signed token in ?t=, which names one
 * pitch and one action (lib/autopilot/hold-token.ts).
 *
 * GET  → a confirmation page with one button. A GET never holds anything:
 *        mail scanners (Safe Links, Mimecast) and link previews open every link
 *        in an email. It only reads the pitch to show what would be held.
 * POST → the hold (lib/autopilot/hold.ts): one status-guarded update, so a
 *        pitch the send-queue already claimed or sent is reported, not touched.
 */

import { NextResponse, type NextRequest } from "next/server";
import { holdPitch, loadHoldTarget, type HoldState } from "@/lib/autopilot/hold";
import { holdSecret, verifyHoldToken, type HoldPayload } from "@/lib/autopilot/hold-token";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";

const COPY = {
  title: "Hold email",
  button: "Hold this email",
  done: "Held. It will not send. It's back in draft on /pitches, in the review lane.",
  invalid: "This hold link isn't valid or has expired. Open /pitches and move the email back to draft there.",
  failed: "Something went wrong and the email was NOT held. Open /pitches and move it back to draft there.",
  states: {
    already_sent: "This email has already been sent. Nothing was changed.",
    sending: "This email is being sent right now and can't be held. Nothing was changed.",
    already_held: "This email is already held (back in draft). Nothing was changed.",
    not_scheduled: "This email isn't scheduled to send any more. Nothing was changed.",
    not_found: "This email no longer exists. Nothing was changed.",
  } satisfies Record<Exclude<HoldState, "holdable">, string>,
} as const;

function readToken(request: NextRequest): HoldPayload | null {
  const token = request.nextUrl.searchParams.get("t");
  const secret = holdSecret();
  if (!token || !secret) return null;
  return verifyHoldToken(token, secret);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatSendTime(iso: string | null): string {
  if (!iso) return "not scheduled";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "not scheduled";
  return `${at.toLocaleString("en-US", {
    timeZone: "America/Mexico_City",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })} (Mexico City time)`;
}

function page(paragraphs: string[], form?: { action: string; button: string }, status = 200) {
  const formHtml = form
    ? `<form method="post" action="${escapeHtml(form.action)}"><button type="submit">${escapeHtml(form.button)}</button></form>`
    : "";
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${COPY.title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; background: #fafafa; color: #1a1a1a; margin: 0; padding: 48px 16px; }
  main { max-width: 440px; margin: 0 auto; background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 28px 24px; }
  p { font-size: 16px; line-height: 1.5; margin: 0 0 20px; overflow-wrap: anywhere; }
  button { font: inherit; font-size: 15px; font-weight: 600; background: #1a1a1a; color: #fff; border: 0; border-radius: 8px; padding: 12px 20px; cursor: pointer; }
</style>
</head>
<body><main>${body}${formHtml}</main></body>
</html>`;
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest) {
  const payload = readToken(request);
  if (!payload) return page([COPY.invalid], undefined, 400);

  try {
    // Read only. Nothing on this path writes.
    const target = await loadHoldTarget(createServiceRoleClient(), payload);
    if (target.state !== "holdable") return page([COPY.states[target.state]]);
    return page(
      [
        `Hold this email to ${target.company || "this prospect"}?`,
        `Subject: "${target.subject}"`,
        `Scheduled to send: ${formatSendTime(target.scheduledSendAt)}`,
        "Holding it moves it back to draft. It counts as a veto and won't be re-queued.",
      ],
      { action: `${request.nextUrl.pathname}${request.nextUrl.search}`, button: COPY.button },
    );
  } catch (err) {
    console.error("[autopilot-hold] lookup failed:", err);
    return page([COPY.failed], undefined, 500);
  }
}

export async function POST(request: NextRequest) {
  const payload = readToken(request);
  if (!payload) return page([COPY.invalid], undefined, 400);

  try {
    const result = await holdPitch(createServiceRoleClient(), payload);
    if (result.state === "held") return page([COPY.done]);
    return page([COPY.states[result.state]]);
  } catch (err) {
    console.error("[autopilot-hold] hold failed:", err);
    return page([COPY.failed], undefined, 500);
  }
}
