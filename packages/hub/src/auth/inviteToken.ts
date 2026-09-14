import { createHmac, timingSafeEqual } from 'crypto';
import type { DB } from '../db.js';

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

/**
 * Is this error the backend's "row already exists" signal?
 *
 * Both invite kinds burn their nonce by INSERTing the PRIMARY KEY, so the
 * unique violation IS the single-use check under concurrency. Everything else
 * (a DB outage, a disk error) must propagate: reporting those as "invite
 * already used" would tell a child hub to give up on a perfectly good invite.
 */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  if (e?.code === '23505') return true;                                    // Postgres unique_violation
  if (typeof e?.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) return true;
  return typeof e?.message === 'string'
    && /UNIQUE constraint failed|duplicate key value/i.test(e.message);
}

/**
 * Burn an invite nonce inside the caller's transaction. Returns false when the
 * invite was already spent (either seen up front, or lost the INSERT race).
 * Any other failure throws, so the caller's transaction rolls back and the
 * invite stays usable.
 */
export async function burnInviteNonce(db: DB, nonce: string, orgId: string): Promise<boolean> {
  const seen = await db.get('SELECT 1 AS x FROM used_invites WHERE nonce = ?', [nonce]);
  if (seen) return false;
  try {
    await db.run('INSERT INTO used_invites (nonce, org_id) VALUES (?, ?)', [nonce, orgId]);
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
  return true;
}
