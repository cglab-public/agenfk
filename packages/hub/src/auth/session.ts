import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { SessionPayload } from '../types.js';

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

export function requireSession(secret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) { res.status(401).json({ error: 'Not signed in' }); return; }
    const session = verifySession(token, secret);
    if (!session) { res.status(401).json({ error: 'Session expired or invalid' }); return; }
    req.session = session;
    next();
  };
}

export function requireAdmin(secret: string) {
  const baseGuard = requireSession(secret);
  return (req: Request, res: Response, next: NextFunction): void => {
    baseGuard(req, res, (err?: any) => {
      if (err) return next(err);
      if (req.session?.role !== 'admin') { res.status(403).json({ error: 'Admin role required' }); return; }
      next();
    });
  };
}
