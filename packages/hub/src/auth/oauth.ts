import { randomBytes } from 'crypto';
import { Request, Response } from 'express';
import { DB } from '../db.js';
import { setSessionCookie, signSession } from './session.js';
import { recordLogin, UserRow } from './password.js';
import { SessionPayload } from '../types.js';

export const OAUTH_STATE_COOKIE = 'agenfk_hub_oauth_state';
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface AllowlistResult { allowed: boolean; reason?: string }

export function checkEmailAllowlist(email: string, allowlistJson: string | null): AllowlistResult {
  if (!allowlistJson) return { allowed: true };
  try {
    const list = JSON.parse(allowlistJson) as string[];
    if (!Array.isArray(list) || list.length === 0) return { allowed: true };
    const lower = email.toLowerCase();
    for (const pattern of list) {
      const p = pattern.toLowerCase();
      if (p.startsWith('*.') && lower.endsWith(p.slice(1))) return { allowed: true };
      if (p.startsWith('@') && lower.endsWith(p)) return { allowed: true };
      if (lower.endsWith('@' + p)) return { allowed: true };
      if (lower === p) return { allowed: true };
    }
    return { allowed: false, reason: `Email ${email} not in allowlist` };
  } catch {
    return { allowed: true }; // malformed allowlist → fail open (admin can fix)
  }
}

export function issueOAuthState(res: Response): string {
  const state = randomBytes(24).toString('hex');
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    maxAge: OAUTH_STATE_TTL_MS, path: '/',
  });
  return state;
}

export function verifyOAuthState(req: Request, given: string | undefined): boolean {
  const cookie = req.cookies?.[OAUTH_STATE_COOKIE];
  return !!cookie && !!given && cookie === given;
}

export interface SsoIdentity {
  provider: 'google' | 'entra';
  subject: string;
  email: string;
}

/**
 * Look up an SSO user that an admin has previously invited (a row exists in
 * `users` matching either the provider+subject pair or the email). Returns
 * null when no such row exists — callers must treat null as "not invited"
 * and reject with 403 instead of auto-provisioning.
 *
 * On first SSO sign-in for an email-invited user, the row is upgraded in
 * place (provider flips from 'password' to the SSO provider, subject is
 * filled in). The user keeps their id and role.
 */
export async function findInvitedSsoUser(
  db: DB,
  _orgId: string,
  identity: SsoIdentity,
): Promise<UserRow | null> {
  const existing = await db.get<UserRow>(
    'SELECT * FROM users WHERE provider = ? AND provider_subject = ?',
    [identity.provider, identity.subject],
  );
  if (existing) return existing;

  const byEmail = await db.get<UserRow>(
    'SELECT * FROM users WHERE lower(email) = lower(?)',
    [identity.email],
  );
  if (byEmail) {
    await db.run(
      'UPDATE users SET provider = ?, provider_subject = ? WHERE id = ?',
      [identity.provider, identity.subject, byEmail.id],
    );
    return { ...byEmail, provider: identity.provider, provider_subject: identity.subject };
  }

  return null;
}

export async function completeSsoLogin(
  db: DB,
  res: Response,
  user: UserRow,
  sessionSecret: string,
): Promise<void> {
  await recordLogin(db, user.id);
  const payload: SessionPayload = { userId: user.id, orgId: user.org_id, role: user.role };
  setSessionCookie(res, signSession(payload, sessionSecret));
}
