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

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
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
