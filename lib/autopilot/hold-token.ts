/**
 * Signed hold tokens for the veto digest's per-pitch "Hold" links.
 *
 * The link must work from a phone without a login, for one pitch and one
 * action, and must not be forgeable or reusable for anything else. Same wire
 * shape as the unsubscribe token (lib/compliance/unsubscribe-token.ts):
 *
 *   base64url(json payload) "." base64url(hmac(secret, payload part))
 *
 * The key is derived from TOKEN_ENCRYPTION_KEY with its own purpose label, so
 * an unsubscribe token never verifies as a hold token and vice versa. No key →
 * no secret → the digest carries no links and the route answers "invalid".
 *
 * Pure apart from node:crypto and one env read — tested in tests/autopilot-hold.test.ts.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type HoldPayload = {
  pitchId: string;
  tenantId: string;
  /** Unix seconds after which the link is dead. */
  exp: number;
};

type Wire = { v: 1; k: "hold"; p: string; t: string; exp: number };

/** How long a hold link outlives the pitch's scheduled send. */
export const HOLD_LINK_GRACE_MS = 24 * 3_600_000;

/** The hold-link key, or null when TOKEN_ENCRYPTION_KEY is unset (fail closed). */
export function holdSecret(base: string | undefined = process.env.TOKEN_ENCRYPTION_KEY): string | null {
  if (!base) return null;
  return createHash("sha256").update(`autopilot-hold-v1:${base}`).digest("hex");
}

/** Expiry for a pitch scheduled at `scheduledSendAt`: the send time + 24h. */
export function holdExpiry(scheduledSendAt: string | Date): number {
  return Math.floor((new Date(scheduledSendAt).getTime() + HOLD_LINK_GRACE_MS) / 1000);
}

function sign(part: string, secret: string): string {
  return createHmac("sha256", secret).update(part).digest("base64url");
}

export function signHoldToken(payload: HoldPayload, secret: string): string {
  const wire: Wire = { v: 1, k: "hold", p: payload.pitchId, t: payload.tenantId, exp: payload.exp };
  const part = Buffer.from(JSON.stringify(wire), "utf8").toString("base64url");
  return `${part}.${sign(part, secret)}`;
}

/** The payload when the signature is valid and the link hasn't expired, else null. Never throws. */
export function verifyHoldToken(token: string, secret: string, now: Date = new Date()): HoldPayload | null {
  const [part, mac, extra] = token.split(".");
  if (!part || !mac || extra !== undefined) return null;

  const expected = Buffer.from(sign(part, secret));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const wire = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Partial<Wire>;
    if (wire.v !== 1 || wire.k !== "hold") return null;
    if (typeof wire.p !== "string" || !wire.p || typeof wire.t !== "string" || !wire.t) return null;
    if (typeof wire.exp !== "number" || !Number.isFinite(wire.exp)) return null;
    if (now.getTime() >= wire.exp * 1000) return null;
    return { pitchId: wire.p, tenantId: wire.t, exp: wire.exp };
  } catch {
    return null;
  }
}
