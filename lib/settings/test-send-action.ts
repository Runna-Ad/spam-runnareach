"use server";

/**
 * "Send test email" (Settings → Sending): one sample pitch through the exact
 * pipeline a real send uses — MIME builder, quoted-printable encoding, CTA
 * button, CASL footer, List-Unsubscribe header, Gmail API — to an address you
 * choose. It creates no prospect, pitch or follow-up and touches no metrics,
 * so checking how an email really lands costs nothing and leaves no trace.
 *
 * Clicking its unsubscribe link puts the TEST address on the do-not-contact
 * list (that's the point: it proves the opt-out works). Use a +tag address,
 * e.g. you+test1@gmail.com, so your real address stays clean.
 */

import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getOutboundCompliance } from "@/lib/compliance/outbound";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import { buildHunterUrl } from "@/lib/pitches/hunter-mapping";
import { senderIdentity } from "@/lib/pitches/sender-identity";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({
  inbox_id: z.string().uuid(),
  to: z.string().trim().email().max(200),
  lang: z.enum(["en", "es"]),
});

const SAMPLE = {
  en: {
    subject: "[Test] S.P.A.M. email check",
    body: (name: string, url: string) =>
      `Hi ${name},\n\n` +
      "This is a test of exactly what a prospect receives from S.P.A.M. It checks three things: accents survive the trip (Montréal, São Paulo, según, café, Ñuñoa), the call to action below shows up as a button, and the footer shows the address, website, contact email and an unsubscribe link.\n\n" +
      `👉 See it for yourself: ${url}\n\n` +
      `${name}\n${senderIdentity("en").agency}`,
  },
  es: {
    subject: "[Prueba] Revisión de correo S.P.A.M.",
    body: (name: string, url: string) =>
      `Hola ${name},\n\n` +
      "Esta es una prueba de lo que recibe exactamente un prospecto desde S.P.A.M. Revisa tres cosas: que los acentos lleguen bien (según, información, año, José María Núñez, pingüino), que el llamado a la acción de abajo se vea como botón y que el pie de correo muestre la dirección, el sitio, el correo de contacto y el enlace para darse de baja.\n\n" +
      `👉 Revísalo tú mismo: ${url}\n\n` +
      `${name}\n${senderIdentity("es").agency}`,
  },
} as const;

export async function sendTestEmail(
  input: z.input<typeof schema>,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const user = await requireUser().catch(() => null);
  if (!user) return { ok: false, error: "Not authenticated." };
  if (user.role === "viewer") return { ok: false, error: "Not authorised." };

  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a valid email address." };
  const { inbox_id, to, lang } = parsed.data;

  const supabase = await createClient();
  const { data: inbox } = await supabase
    .from("sender_inboxes")
    .select("id, email, display_name, gmail_refresh_token_encrypted")
    .eq("id", inbox_id)
    .eq("tenant_id", user.tenantId)
    .maybeSingle();
  if (!inbox) return { ok: false, error: "Inbox not found." };
  if (!inbox.gmail_refresh_token_encrypted) return { ok: false, error: "That inbox isn't connected to Gmail." };

  const compliance = getOutboundCompliance({ tenantId: user.tenantId, prospectId: null, email: to, lang });
  if (!compliance.ok) return { ok: false, error: compliance.error };

  const token = await getAccessToken(inbox.gmail_refresh_token_encrypted);
  if (!token.ok) return { ok: false, error: `Gmail auth failed: ${token.error}` };

  const sender = senderIdentity(lang);
  const firstName = sender.firstName;
  const sample = SAMPLE[lang];
  const sent = await sendGmailMessage({
    accessToken: token.accessToken,
    fromEmail: inbox.email,
    fromName: sender.displayName,
    to,
    subject: sample.subject,
    body: sample.body(firstName, buildHunterUrl({ market: lang === "es" ? "mx" : "ca" })),
    lang,
    footer: compliance.value.footer,
    listUnsubscribe: compliance.value.listUnsubscribe,
  });
  if (!sent.ok) return { ok: false, error: sent.error };

  return { ok: true, message: `Sent the ${lang === "es" ? "Spanish" : "English"} test to ${to} from ${inbox.email}.` };
}
