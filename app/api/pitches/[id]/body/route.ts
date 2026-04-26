import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getPitch } from "@/lib/pitches/queries";

/**
 * Returns the editable subject + current body for a pitch. Body is the
 * edited copy if present, otherwise the original heuristic-generated
 * copy. Used by the pitches detail pane to lazy-load body text without
 * shipping it in the list payload.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  const { id } = await ctx.params;
  const pitch = await getPitch(user.tenantId, id);
  if (!pitch) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    subject: pitch.subject,
    body: pitch.body_edited ?? pitch.body_original,
  });
}
