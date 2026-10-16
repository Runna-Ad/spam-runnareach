/**
 * Signed unsubscribe tokens.
 *
 * The unsubscribe link must work without a login and without a database lookup
 * to prove it's genuine, and nobody should be able to unsubscribe someone else
 * by guessing an id. So the token carries who it's for, signed with HMAC-SHA256:
 *
 *   base64url(json payload) "." base64url(hmac(secret, payload part))
 *
 * Pure apart from node:crypto — unit-tested in tests/compliance.test.ts.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type UnsubscribePayload = {
  tenantId: string;
  /** Null for a send that isn't tied to a prospect row. */
  prospectId: string | null;
  email: string;
  lang: "en" | "es";
};

type Wire = { v: 1; t: string; p: string | null; e: string; l: "en" | "es" };

function sign(part: string, secret: string): string {
  return createHmac("sha256", secret).update(part).digest("base64url");
}

export function signUnsubscribeToken(payload: UnsubscribePayload, secret: string): string {
  const wire: Wire = {
    v: 1,
    t: payload.tenantId,
    p: payload.prospectId,
    e: payload.email.trim().toLowerCase(),
    l: payload.lang,
  };
  const part = Buffer.from(JSON.stringify(wire), "utf8").toString("base64url");
  return `${part}.${sign(part, secret)}`;
}

/** The payload when the signature is valid, else null. Never throws. */
export function verifyUnsubscribeToken(token: string, secret: string): UnsubscribePayload | null {
  const [part, mac, extra] = token.split(".");
  if (!part || !mac || extra !== undefined) return null;

  const expected = Buffer.from(sign(part, secret));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const wire = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Partial<Wire>;
    if (wire.v !== 1 || typeof wire.t !== "string" || typeof wire.e !== "string") return null;
    if (!wire.e.includes("@")) return null;
    return {
      tenantId: wire.t,
      prospectId: typeof wire.p === "string" ? wire.p : null,
      email: wire.e,
      lang: wire.l === "es" ? "es" : "en",
    };
  } catch {
    return null;
  }
}
