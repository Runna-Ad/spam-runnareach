/**
 * Tracked free-check link: /r/<code>?<hunter params>[&s=1|2].
 *
 * Public (prospects click it from cold emails). Always a 302 to the free check
 * (runna-hunter), whose host is a constant: the request can never choose where
 * the visitor goes. The click is recorded on the conversation's ROOT pitch after
 * the response is sent, minus HEAD requests, link scanners, repeats within 10
 * minutes and test addresses. Logic and contract: lib/pitches/tracked-links.ts.
 */

import { after, NextResponse, type NextRequest } from "next/server";
import { hunterDestination, planTrackedClick } from "@/lib/pitches/tracked-links";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest, ctx: { params: Promise<{ code: string }> }): Promise<NextResponse> {
  const search = req.nextUrl.searchParams;
  let location: string;
  try {
    const { code } = await ctx.params;
    const plan = await planTrackedClick(createServiceRoleClient(), {
      code,
      method: req.method,
      userAgent: req.headers.get("user-agent"),
      search,
    });
    location = plan.location;
    const record = plan.record;
    if (record) after(async () => void (await record()));
  } catch {
    // Missing config or anything else: the prospect still gets the free check.
    location = hunterDestination(search, null);
  }
  const res = NextResponse.redirect(location, 302);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

export const GET = handle;
export const HEAD = handle;
