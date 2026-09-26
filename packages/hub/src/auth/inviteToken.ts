import { createHmac, timingSafeEqual } from 'crypto';
import type { DB } from '../db.js';
import { normalizeHttpUrl } from '../util/httpUrl.js';

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
/** An invite is ~200 chars. Every route that verifies one caps the input first,
 *  so an unauthenticated caller cannot make the hub HMAC megabytes per request. */
export const MAX_INVITE_TOKEN_LEN = 4096;

export type InviteKind = 'installation' | 'child-hub';

export interface InvitePayload {
  orgId: string;
  nonce: string;
  exp: number;
  kind?: InviteKind;
  /**
   * The issuing hub's own public URL. Set on 'child-hub' invites so the token
   * is the single thing a child hub's admin has to paste — see
   * {@link parentUrlFromInviteToken}.
   */
  parentUrl?: string;
}

/** Nothing legitimate comes close; past this we do not even decode. */
const MAX_TOKEN_LEN = 4096;

/** The base64url JSON body of a token, or null if it is not one. */
function decodeBody(body: string): any | null {
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
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
  const parsed = decodeBody(body);
  if (typeof parsed?.orgId !== 'string' || typeof parsed.nonce !== 'string' || typeof parsed.exp !== 'number') return null;
  const tokenKind: InviteKind = parsed.kind === undefined ? 'installation' : parsed.kind;
  if (tokenKind !== kind) return null;
  return {
    orgId: parsed.orgId, nonce: parsed.nonce, exp: parsed.exp, kind: tokenKind,
    ...(typeof parsed.parentUrl === 'string' ? { parentUrl: parsed.parentUrl } : {}),
  };
}

/**
 * Read the parent hub's URL out of a child-hub invite WITHOUT verifying it.
 *
 * This is the child's side of the handshake, and a child cannot verify a token
 * the parent signed — that key never leaves the parent. So the signature is
 * checked where it can be, at the parent's /v1/federation/enroll, and this only
 * decides where to send the redemption. It is therefore attacker-controlled
 * input: bounded, parsed defensively, and narrowed to http(s).
 *
 * The value returned is NORMALISED, not the string as written. It is what the
 * admin is shown before clicking Join and what the client then dials, and those
 * two have to be the same string: `https://parent.example.com@evil.example.com`
 * reads as one host and connects to another. Callers must still apply their own
 * SSRF policy (private/loopback).
 *
 * Returns null for anything that is not a child-hub invite carrying a usable
 * URL, including invites minted before the URL was signed in.
 */
export function parentUrlFromInviteToken(token: string): string | null {
  const claims = childHubInviteClaims(token);
  return claims ? claims.parentUrl : null;
}

/**
 * The expiry a child-hub invite claims, unverified, or null if it claims none.
 *
 * Lets the child refuse a stale token with a local message instead of sending
 * somebody's server a request and relaying a confusing 4xx back.
 */
export function inviteExpiryFromToken(token: string): number | null {
  const claims = childHubInviteClaims(token);
  return claims ? claims.exp : null;
}

/** The unverified claims of a child-hub invite, or null if it is not one. */
function childHubInviteClaims(token: string): { parentUrl: string; exp: number } | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LEN) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = decodeBody(token.slice(0, dot));
  // An installation invite pasted into the join box fails here, locally, with
  // something the admin can act on — rather than after a round trip.
  if (body?.kind !== 'child-hub' || typeof body.exp !== 'number') return null;
  const parentUrl = normalizeHttpUrl(body.parentUrl);
  return parentUrl ? { parentUrl, exp: body.exp } : null;
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
