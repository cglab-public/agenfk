import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { SessionPayload } from '../types.js';
import { DB } from '../db.js';

export const SESSION_COOKIE = 'agenfk_hub_session';
export const SESSION_TTL_HOURS = 12;

declare module 'express-serve-static-core' {
  interface Request {
    session?: SessionPayload;
  }
}

export function signSession(payload: SessionPayload, secret: string): string {
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: `${SESSION_TTL_HOURS}h` });
}

export function verifySession(token: string, secret: string): SessionPayload | null {
  try {
    return jwt.verify(token, secret) as SessionPayload;
  } catch {
    return null;
  }
}

// Whether to mark auth cookies Secure. Tying this to NODE_ENV alone meant a
// TLS-terminated staging hub (NODE_ENV !== 'production') set the session JWT
// WITHOUT Secure, so a protocol downgrade could leak it. Derive from the actual
// request protocol and an explicit override, so any HTTPS-served deployment
// gets Secure. (Security: bug f3d62844.) req.secure is Express's answer: it
// honours X-Forwarded-Proto from the hops AGENFK_HUB_TRUST_PROXY trusts, so it
// is only as honest as that setting. The raw header is not read.
export function cookieSecure(req?: Request): boolean {
  const explicit = process.env.AGENFK_HUB_COOKIE_SECURE;
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  if (req?.secure) return true;
  return process.env.NODE_ENV === 'production';
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cookieSecure(res.req),
    sameSite: 'lax',
    maxAge: SESSION_TTL_HOURS * 3600 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * A signed-in request, checked against the user's row as it is NOW.
 *
 * The cookie is signed for 12 hours, and what it says about the user can go
 * stale long before that: they can be deactivated, deleted, or have their role
 * changed. So the token only proves who is asking; whether they may, and as
 * what, is read from `users` on every request (one primary-key lookup). The
 * row's role replaces the cookie's on req.session, so a demoted admin is a
 * viewer from their next request, and a promoted viewer an admin.
 */
/** The guard's per-request read of the signed-in user. Exported for tests that need to hold it. */
export const SESSION_USER_SQL = 'SELECT role, active, org_id FROM users WHERE id = ?';

export function requireSession(secret: string, db: DB) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) { res.status(401).json({ error: 'Not signed in' }); return; }
    const session = verifySession(token, secret);
    if (!session) { res.status(401).json({ error: 'Session expired or invalid' }); return; }
    // express 4 does not forward a rejected middleware promise: catch it here,
    // or a DB error leaves the request with no response at all.
    db.get<{ role: SessionPayload['role']; active: number; org_id: string }>(SESSION_USER_SQL, [session.userId]).then((user) => {
      // A throw in here would otherwise escape as an unhandled rejection
      // (downstream handlers are covered by express's own try/catch).
      try {
        if (!user || !Number(user.active) || user.org_id !== session.orgId) {
          res.status(401).json({ error: 'Session no longer valid; sign in again' });
          return;
        }
        req.session = { ...session, role: user.role };
        next();
      } catch (err) {
        next(err instanceof Error ? err : new Error(String(err)));
      }
    }, (err: unknown) => next(err instanceof Error ? err : new Error(String(err))));
  };
}

export function requireAdmin(secret: string, db: DB) {
  const baseGuard = requireSession(secret, db);
  return (req: Request, res: Response, next: NextFunction): void => {
    baseGuard(req, res, (err?: any) => {
      if (err) return next(err);
      if (req.session?.role !== 'admin') { res.status(403).json({ error: 'Admin role required' }); return; }
      next();
    });
  };
}
