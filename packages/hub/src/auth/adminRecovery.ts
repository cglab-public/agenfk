import { createHash, randomBytes } from 'crypto';
import type { DB } from '../db.js';
import { findUserByEmail, hashPassword, type UserRow } from './password.js';

/**
 * Admin recovery for a hub whose SSO broke (STORY a44f3697).
 *
 * When every admin signs in by SSO (no password hash) and password sign-in is
 * switched off, a broken provider leaves nobody able to get in, and the
 * bootstrap token only works on an empty hub. The operator restarts the hub
 * with AGENFK_HUB_RESET_ADMIN_EMAIL naming an admin: boot mints a token for
 * that admin and logs it, as the bootstrap token is; redeeming it sets the
 * admin's password and signs them in, whatever the sign-in settings say.
 *
 * Access to the host - its environment and its logs - is the trust boundary;
 * nothing in the app can mint one. The token is single-use, expires, and is
 * kept only as a hash; a boot clears only expired ones.
 */
export const RECOVERY_TTL_MS = 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;

const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** An active admin of `orgId`, or null. */
const activeAdmin = (user: UserRow | null, orgId: string): UserRow | null =>
  user && user.org_id === orgId && user.role === 'admin' && Number(user.active) === 1 ? user : null;

export type MintResult = { token: string; email: string; expiresAt: string } | { refused: string };

/** Mints a recovery token for the admin `email` names; tokens already logged stay until used or expired. */
export async function mintAdminRecoveryToken(db: DB, orgId: string, email: string, now = Date.now()): Promise<MintResult> {
  const admin = activeAdmin(await findUserByEmail(db, email), orgId);
  // Only expired tokens go (BUG 91d2941d): another hub instance's boot, or a
  // restart mid-recovery, must not withdraw the token the operator is reading.
  await withdrawExpiredRecoveryTokens(db, now);
  if (!admin) return { refused: `no active admin of this hub has the email ${JSON.stringify(email)}` };
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + RECOVERY_TTL_MS).toISOString();
  await db.run('INSERT INTO admin_recovery_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [hashToken(token), admin.id, expiresAt]);
  return { token, email: admin.email, expiresAt };
}

/** Clears the tokens that can no longer be used. */
export async function withdrawExpiredRecoveryTokens(db: DB, now = Date.now()): Promise<void> {
  await db.run('DELETE FROM admin_recovery_tokens WHERE expires_at <= ?', [new Date(now).toISOString()]);
}

export type RedeemResult = { user: UserRow } | { status: 400 | 401; error: string };

/**
 * Redeems a recovery token: sets the admin's password (a password account
 * from now on - an SSO sign-in moves it back) and spends the token, in one
 * transaction. Refused when the token is unknown, spent or expired, or its
 * admin is no longer an active admin.
 */
export async function redeemAdminRecoveryToken(db: DB, orgId: string, token: unknown, password: unknown, now = Date.now()): Promise<RedeemResult> {
  const refused = { status: 401 as const, error: 'Invalid or expired recovery token' };
  if (typeof token !== 'string' || !token.trim()) return refused;
  const tokenHash = hashToken(token.trim());
  const row = await db.get<{ user_id: string; expires_at: string }>('SELECT user_id, expires_at FROM admin_recovery_tokens WHERE token_hash = ?', [tokenHash]);
  if (!row || !(new Date(String(row.expires_at)).getTime() > now)) return refused;
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { status: 400, error: `A new password of at least ${MIN_PASSWORD_LENGTH} characters is required` };
  }
  const user = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', [row.user_id]);
  if (!activeAdmin(user ?? null, orgId)) return refused;
  let spent = false;
  await db.transaction(async () => {
    const consumed = await db.run('DELETE FROM admin_recovery_tokens WHERE token_hash = ?', [tokenHash]);
    if (consumed.changes !== 1) return;   // another request spent it first
    await db.run("UPDATE users SET password_hash = ?, provider = 'password' WHERE id = ?", [hashPassword(password), user!.id]);
    spent = true;
  });
  return spent ? { user: user! } : refused;
}
