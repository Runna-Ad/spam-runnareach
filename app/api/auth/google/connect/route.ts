/**
 * GET /api/auth/google/connect?inbox_id=<uuid>
 *
 * Initiates the Gmail OAuth flow for a specific sender inbox.
 * Redirects the browser to Google's consent page.
 * State param carries the inbox_id so the callback knows which row to update.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
].join(" ");

export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.redirect(new URL("/sign-in", req.url));
  }
  if (user.role === "viewer") {
    return NextResponse.json({ error: "Not authorised." }, { status: 403 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "GOOGLE_CLIENT_ID not configured." }, { status: 500 });
  }

  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/auth/google/callback`;

  const inboxId = req.nextUrl.searchParams.get("inbox_id");
  if (!inboxId) {
    return NextResponse.json({ error: "inbox_id required." }, { status: 400 });
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
    return NextResponse.json({ error: "Inbox not found." }, { status: 404 });
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",   // get refresh_token
    prompt: "consent",        // force consent so we always get refresh_token
    state: inboxId,
  });

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  );
}
