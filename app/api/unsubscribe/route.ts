/**
 * Unsubscribe endpoint — the target of the footer link and the List-Unsubscribe
 * header. Public: no login, authorised only by the signed token in ?t=.
 *
 * GET  → a confirmation page with one button. A GET never unsubscribes, because
 *        corporate link scanners (Safe Links, Mimecast) open every link in an
 *        email; acting on GET would silently unsubscribe whole companies.
 * POST → unsubscribes. Two senders:
 *        - mail clients doing RFC 8058 one-click (body "List-Unsubscribe=One-Click"),
 *          which expect a bare 200;
 *        - the confirmation page's button, which gets a "done" page.
 */

import { NextResponse, type NextRequest } from "next/server";
import { recordOptOut } from "@/lib/compliance/opt-out";
import { unsubscribeSecret } from "@/lib/compliance/outbound";
import { verifyUnsubscribeToken, type UnsubscribePayload } from "@/lib/compliance/unsubscribe-token";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";

const COPY = {
  en: {
    title: "Unsubscribe",
    confirm: (email: string) => `Stop all emails from us to ${email}?`,
    button: "Unsubscribe",
    done: (email: string) => `Done. ${email} won't receive any more emails from us.`,
    invalid: "This unsubscribe link isn't valid. Reply to the email with the word \"unsubscribe\" and we'll remove you.",
    failed: "Something went wrong on our side. Reply to the email with the word \"unsubscribe\" and we'll remove you right away.",
  },
  es: {
    title: "Darse de baja",
    confirm: (email: string) => `¿Dejar de enviar correos a ${email}?`,
    button: "Darme de baja",
    done: (email: string) => `Listo. ${email} no recibirá más correos de nuestra parte.`,
    invalid: "Este enlace no es válido. Responde al correo con la palabra \"baja\" y te quitaremos de la lista.",
    failed: "Algo falló de nuestro lado. Responde al correo con la palabra \"baja\" y te quitaremos de inmediato.",
  },
} as const;

function readToken(request: NextRequest): UnsubscribePayload | null {
  const token = request.nextUrl.searchParams.get("t");
  const secret = unsubscribeSecret();
  if (!token || !secret) return null;
  return verifyUnsubscribeToken(token, secret);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(lang: "en" | "es", message: string, form?: { action: string; button: string }, status = 200) {
  const formHtml = form
    ? `<form method="post" action="${escapeHtml(form.action)}"><button type="submit">${escapeHtml(form.button)}</button></form>`
    : "";
  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${COPY[lang].title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; background: #fafafa; color: #1a1a1a; margin: 0; padding: 48px 16px; }
  main { max-width: 440px; margin: 0 auto; background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 28px 24px; }
  p { font-size: 16px; line-height: 1.5; margin: 0 0 20px; }
  button { font: inherit; font-size: 15px; font-weight: 600; background: #1a1a1a; color: #fff; border: 0; border-radius: 8px; padding: 12px 20px; cursor: pointer; }
</style>
</head>
<body><main><p>${escapeHtml(message)}</p>${formHtml}</main></body>
</html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function GET(request: NextRequest) {
  const payload = readToken(request);
  if (!payload) return page("en", `${COPY.en.invalid}\n\n${COPY.es.invalid}`, undefined, 400);
  const copy = COPY[payload.lang];
  return page(payload.lang, copy.confirm(payload.email), {
    action: `${request.nextUrl.pathname}${request.nextUrl.search}`,
    button: copy.button,
  });
}

export async function POST(request: NextRequest) {
  const payload = readToken(request);
  const body = await request.text().catch(() => "");
  const oneClick = /List-Unsubscribe=One-Click/i.test(body);

  if (!payload) {
    return oneClick
      ? new NextResponse("Invalid unsubscribe token", { status: 400 })
      : page("en", `${COPY.en.invalid}\n\n${COPY.es.invalid}`, undefined, 400);
  }

  const result = await recordOptOut(createServiceRoleClient(), {
    tenantId: payload.tenantId,
    prospectId: payload.prospectId,
    email: payload.email,
    source: oneClick ? "one_click" : "unsubscribe_link",
  });

  if (!result.ok) {
    console.error("[unsubscribe] failed:", result.error);
    return oneClick
      ? new NextResponse("Unsubscribe failed, please reply to the email instead", { status: 500 })
      : page(payload.lang, COPY[payload.lang].failed, undefined, 500);
  }
  return oneClick
    ? new NextResponse("Unsubscribed", { status: 200 })
    : page(payload.lang, COPY[payload.lang].done(payload.email));
}
