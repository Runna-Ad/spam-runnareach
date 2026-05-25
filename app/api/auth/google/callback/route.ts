/**
 * GET /api/auth/google/callback?code=...&state=<inbox_id>
 *
 * Exchanges the authorization code for tokens, encrypts the refresh token,
 * and stores it on the sender_inbox row. Redirects back to settings/sending.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { encryptToken } from "@/lib/gmail/crypto";

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Derive origin from request — don't rely on NEXT_PUBLIC_APP_URL
  const origin = req.nextUrl.origin;
  const settingsUrl = `${origin}/settings/sending`;

  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.redirect(`${origin}/sign-in`);
  }

  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const inboxId = searchParams.get("state"); // state = inbox_id we set in /connect
  const oauthError = searchParams.get("error");

  if (oauthError) {
    return NextResponse.redirect(`${settingsUrl}?gmail_error=${encodeURIComponent(oauthError)}`);
  }
  if (!code || !inboxId) {
    return NextResponse.redirect(`${settingsUrl}?gmail_error=missing_params`);
  }

  // Verify the inbox belongs to this tenant
  const supabase = await createClient();
  const { data: inbox } = await supabase
    .from("sender_inboxes")
    .select("id")
    .eq("id", inboxId)
    .eq("tenant_id", user.tenantId)
    .maybeSingle();

  if (!inbox) {
    return NextResponse.redirect(`${settingsUrl}?gmail_error=inbox_not_found`);
  }

  // Exchange code for tokens
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = `${origin}/api/auth/google/callback`;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${settingsUrl}?gmail_error=missing_credentials`);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    console.error("[gmail/callback] Token exchange failed:", body);
    return NextResponse.redirect(`${settingsUrl}?gmail_error=token_exchange_failed`);
  }

  const tokens = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
  };

  if (!tokens.refresh_token) {
    // This happens if the user already granted access and we didn't use prompt=consent.
    // /connect uses prompt=consent so this shouldn't happen in practice.
    console.error("[gmail/callback] No refresh_token in response:", tokens);
    return NextResponse.redirect(`${settingsUrl}?gmail_error=no_refresh_token`);
  }

  // Encrypt and store
  let encrypted: string;
  try {
    encrypted = encryptToken(tokens.refresh_token);
  } catch (err) {
    console.error("[gmail/callback] Encryption failed:", err);
    return NextResponse.redirect(`${settingsUrl}?gmail_error=encryption_failed`);
  }

  const { error: updateErr } = await supabase
    .from("sender_inboxes")
    .update({ gmail_refresh_token_encrypted: encrypted } as never)
    .eq("id", inboxId)
    .eq("tenant_id", user.tenantId);

  if (updateErr) {
    console.error("[gmail/callback] DB update failed:", updateErr.message);
    return NextResponse.redirect(`${settingsUrl}?gmail_error=db_update_failed`);
  }

  return NextResponse.redirect(`${settingsUrl}?gmail_connected=1`);
}
