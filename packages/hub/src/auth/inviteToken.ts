import { createHmac, timingSafeEqual } from 'crypto';

/**
 * HMAC-signed, self-describing invite tokens (`<base64url body>.<base64url sig>`).
 *
 * Two kinds exist and they are NOT interchangeable:
 *   - 'installation' — `agenfk hub join`, redeemed for an installation api_key
 *     (routes/connect.ts). Legacy tokens carry no `kind` field and are treated
 *     as this kind.
 *   - 'child-hub'    — hub federation (CGLAB-181), redeemed by another hub for a
 *     federation key (routes/federation.ts).
 *
 * `verifyInviteToken(token, secret, kind)` only returns a payload whose kind
 * matches, so a child-hub invite can never mint an installation key and vice
 * versa. Both kinds share the `used_invites` nonce table for single use.
 */
/** Both invite kinds expire 14 days after issue. */
export const INVITE_TTL_MS = 14 * 86400_000;

export type InviteKind = 'installation' | 'child-hub';

export interface InvitePayload {
  orgId: string;
  nonce: string;
  exp: number;
  kind?: InviteKind;
}

export function signInviteToken(payload: InvitePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyInviteToken(token: string, secret: string, kind: InviteKind): InvitePayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sigStr = token.slice(dot + 1);
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
    actual = Buffer.from(sigStr);
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed?.orgId !== 'string' || typeof parsed.nonce !== 'string' || typeof parsed.exp !== 'number') return null;
  const tokenKind: InviteKind = parsed.kind === undefined ? 'installation' : parsed.kind;
  if (tokenKind !== kind) return null;
  return { orgId: parsed.orgId, nonce: parsed.nonce, exp: parsed.exp, kind: tokenKind };
}
