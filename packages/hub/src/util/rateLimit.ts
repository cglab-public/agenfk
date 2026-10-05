import { Request, RequestHandler } from 'express';
import expressRateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { SESSION_COOKIE, verifySession } from '../auth/session.js';

// In-memory rate limiting + brute-force lockout for the hub. The hub is a
// single Node process, so a per-process fixed window is sufficient.
// (Security: bugs 210b3d34, 72f8da10.)
//
// The limiter is express-rate-limit, not the hand-rolled window this file used
// to carry. Behaviour is the same - `max` per window per key, then a 429 with a
// JSON error and Retry-After - but a home-made middleware is invisible to code
// scanning, which reported every hub route as unlimited (CodeQL
// js/missing-rate-limiting, 20 alerts on PR #194) and taught reviewers to
// dismiss that rule wholesale. The package was already in the tree: the local
// server has used it since its own migration.

/** The client IP, as Express derives it from the app's `trust proxy` setting
 *  (AGENFK_HUB_TRUST_PROXY, default one hop). This used to read the FIRST
 *  X-Forwarded-For entry itself - the part the client writes, since a proxy
 *  such as the production ALB appends rather than replaces - so any client
 *  could choose its own bucket. The per-account login lockout and the device
 *  flow's pending-row cap remain the IP-independent backstops. */
export function clientIp(req: Request): string {
  const ip = (req.ip || req.socket?.remoteAddress || 'unknown').toString();
  // An ALB with client ports enabled reports "a.b.c.d:port". Keyed with the
  // port, every TCP connection would be a new client.
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  return v4WithPort ? v4WithPort[1] : ip;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Bucket key; defaults to client IP. */
  keyFn?: (req: Request) => string;
  message?: string;
  /** Count only responses below 400 as free: failures alone spend the budget. */
  skipSuccessfulRequests?: boolean;
}

/** The default bucket: the client IP, with an IPv6 address reduced to its /64.
 *  A v6 client takes a fresh address out of its /64 whenever it likes, so a
 *  key on the exact address hands each one a private budget. */
function clientKey(req: Request): string {
  return ipKeyGenerator(clientIp(req), 64);
}

/**
 * The bucket for a route that requires a session: the VERIFIED session's
 * user, so people sharing one NAT or VPN egress do not share a budget. A
 * cookie that does not verify is charged to the client IP - a forged value
 * must not buy a fresh bucket. Verification is a JWT signature check, the same
 * one the route's own guard runs; it touches no database.
 */
export function sessionUserKey(sessionSecret: string): (req: Request) => string {
  return (req: Request): string => {
    const token = req.cookies?.[SESSION_COOKIE];
    const session = typeof token === 'string' && token ? verifySession(token, sessionSecret) : null;
    return session ? `user:${session.orgId}:${session.userId}` : clientKey(req);
  };
}

/** Fixed-window per-key limiter. Returns 429 once `max` is exceeded within
 *  `windowMs`, with the JSON `error` and a Retry-After header. */
export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const { windowMs, max, keyFn = clientKey, message = 'Too many requests, slow down.', skipSuccessfulRequests = false } = opts;
  // The casts cross a typings seam, nothing more: express-rate-limit is typed
  // against the root @types/express while the hub pins its own copy, and the
  // two Request types are structurally identical at runtime.
  const limiter = expressRateLimit({
    windowMs,
    limit: max,
    skipSuccessfulRequests,
    keyGenerator: (req: any) => keyFn(req as Request),
    standardHeaders: false,
    legacyHeaders: false,
    handler: (req: any, res: any) => {
      // Logged on the first refusal in a bucket's window, so a limit that
      // bites is visible without one line per blocked request. (Under
      // skipSuccessfulRequests a success still in flight can decrement the
      // count back to the limit, so that limiter may log a few times per
      // window.) No address or token: the route, the ceiling, and what the
      // bucket is. The path is printable-ASCII only and capped.
      if (req.rateLimit?.used === max + 1) {
        const kind = String(req.rateLimit?.key ?? '').startsWith('user:') ? 'user' : 'client address';
        const where = `${req.baseUrl ?? ''}${req.path ?? ''}`.replace(/[^\x21-\x7e]/g, '?').slice(0, 200);
        const method = String(req.method ?? '').replace(/[^A-Z]/g, '').slice(0, 10);
        console.warn(`[RATE_LIMIT] ${method} ${where} refused: over ${max} per ${Math.round(windowMs / 1000)}s for one ${kind}`);
      }
      const resetTime = req.rateLimit?.resetTime as Date | undefined;
      const retryAfter = resetTime ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000)) : Math.ceil(windowMs / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: message });
    },
  });
  return limiter as unknown as RequestHandler;
}

/** Per-account failed-attempt lockout. After `maxFailures` failures within
 *  `windowMs`, `isLocked` reports true until the window elapses. Cleared on a
 *  successful auth. Keys are lowercased so casing can't sidestep the lock. */
export class FailedAttemptTracker {
  private failures = new Map<string, { count: number; firstAt: number; lockUntil: number }>();
  constructor(private maxFailures: number, private windowMs: number, private lockMs: number) {}

  private norm(key: string): string { return key.trim().toLowerCase(); }

  isLocked(key: string, now: number = Date.now()): boolean {
    const e = this.failures.get(this.norm(key));
    return !!e && e.lockUntil > now;
  }

  recordFailure(key: string, now: number = Date.now()): void {
    // recordFailure fires for unknown emails too, so an attacker could otherwise
    // seed unlimited distinct keys. Opportunistically drop entries whose window
    // and lock have both elapsed before inserting a new one.
    if (this.failures.size > 10_000) {
      for (const [k2, e2] of this.failures) {
        if (now - e2.firstAt > this.windowMs && e2.lockUntil <= now) this.failures.delete(k2);
      }
    }
    const k = this.norm(key);
    let e = this.failures.get(k);
    if (!e || now - e.firstAt > this.windowMs) {
      e = { count: 0, firstAt: now, lockUntil: 0 };
      this.failures.set(k, e);
    }
    e.count++;
    if (e.count >= this.maxFailures) {
      e.lockUntil = now + this.lockMs;
    }
  }

  clear(key: string): void { this.failures.delete(this.norm(key)); }
}
