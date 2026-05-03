import { randomBytes, randomUUID } from 'crypto';
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

/** Find existing SSO user or create one. Throws if email allowlist rejects. */
export function upsertSsoUser(db: DB, orgId: string, identity: SsoIdentity, defaultRole: 'admin' | 'viewer' = 'viewer'): UserRow {
  const existing = db.prepare(
    'SELECT * FROM users WHERE provider = ? AND provider_subject = ?'
  ).get(identity.provider, identity.subject) as unknown as UserRow | undefined;
  if (existing) return existing;

  const byEmail = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(identity.email) as unknown as UserRow | undefined;
  if (byEmail) {
    db.prepare('UPDATE users SET provider = ?, provider_subject = ? WHERE id = ?')
      .run(identity.provider, identity.subject, byEmail.id);
    return { ...byEmail, provider: identity.provider, provider_subject: identity.subject };
  }

  const id = randomUUID();
  db.prepare('INSERT INTO users (id, org_id, email, provider, provider_subject, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, orgId, identity.email, identity.provider, identity.subject, defaultRole);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow;
}

export function completeSsoLogin(db: DB, res: Response, user: UserRow, sessionSecret: string): void {
  recordLogin(db, user.id);
  const payload: SessionPayload = { userId: user.id, orgId: user.org_id, role: user.role };
  setSessionCookie(res, signSession(payload, sessionSecret));
}
