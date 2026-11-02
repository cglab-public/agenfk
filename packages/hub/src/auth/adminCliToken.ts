import { randomBytes, randomUUID } from 'crypto';
import { DB } from '../db.js';
import { hashToken } from './apiKey.js';

/**
 * The admin CLI's bearer token (CGLAB-702).
 *
 * It is a second carrier for a user's session, next to the board's cookie: it
 * names an org and a user and nothing else. Whether that user may act, and as
 * what, is read from their row on every request by the session guard, so a
 * demoted admin's token is a viewer's at once and a deactivated user's is
 * refused. The token itself lives for as long as a board session does, is held
 * only as a hash, and can be revoked by its holder (sign-out) or by any admin.
 */
export const ADMIN_CLI_TOKEN_PREFIX = 'agka_';
export const ADMIN_CLI_TOKEN_TTL_HOURS = 12;

export interface AdminCliTokenRow { id: string; orgId: string; userId: string; expiresAt: string }

export function isAdminCliToken(token: string): boolean {
  return token.startsWith(ADMIN_CLI_TOKEN_PREFIX);
}

/** Mints the token for one approved device grant and returns it in plain form; only its hash is stored. */
export async function issueAdminCliToken(db: DB, orgId: string, userId: string, grantCode: string): Promise<{ id: string; token: string; expiresAt: string }> {
  const id = randomUUID();
  const token = ADMIN_CLI_TOKEN_PREFIX + randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ADMIN_CLI_TOKEN_TTL_HOURS * 3600 * 1000).toISOString();
  // One statement, and grant_code is UNIQUE: a token exists for the grant or it
  // does not, and a second one for the same grant is refused by the database.
  await db.run(
    'INSERT INTO admin_cli_tokens (id, org_id, user_id, token_hash, created_at, expires_at, grant_code) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, orgId, userId, hashToken(token), new Date().toISOString(), expiresAt, grantCode],
  );
  return { id, token, expiresAt };
}

/** The live token row for `token`, or null when it is unknown, revoked or expired. */
export async function findAdminCliToken(db: DB, token: string): Promise<AdminCliTokenRow | null> {
  if (!isAdminCliToken(token)) return null;
  const row = await db.get<{ id: string; org_id: string; user_id: string; expires_at: string | Date; revoked_at: unknown }>(
    'SELECT id, org_id, user_id, expires_at, revoked_at FROM admin_cli_tokens WHERE token_hash = ?',
    [hashToken(token)],
  );
  if (!row || row.revoked_at) return null;
  // Postgres hands back a Date, SQLite the ISO string we wrote: compare in JS.
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return { id: row.id, orgId: row.org_id, userId: row.user_id, expiresAt: new Date(row.expires_at).toISOString() };
}

/** Revokes one token of `orgId`. Returns whether a live one was revoked. */
export async function revokeAdminCliToken(db: DB, orgId: string, id: string): Promise<boolean> {
  const r = await db.run(
    'UPDATE admin_cli_tokens SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL',
    [new Date().toISOString(), id, orgId],
  );
  return r.changes > 0;
}

/** The bearer a request carries, if any. */
export function bearerOf(authorization: string | undefined): string | null {
  if (!authorization || !authorization.startsWith('Bearer ')) return null;
  const t = authorization.slice('Bearer '.length).trim();
  return t || null;
}

