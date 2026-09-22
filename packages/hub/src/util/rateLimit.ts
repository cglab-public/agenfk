import { Request, RequestHandler } from 'express';
import expressRateLimit, { ipKeyGenerator } from 'express-rate-limit';

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

/** Best-effort client IP. Honours the first x-forwarded-for hop (the hub runs
 *  behind a reverse proxy in production) and falls back to the socket.
 *  NOTE: this trusts x-forwarded-for, so the per-IP limiter is only sound when
 *  a trusted proxy sets it. A directly-exposed hub lets a client spoof the
 *  header for a fresh bucket each request — which is why the login defense's
 *  real teeth are the IP-independent per-account lockout, and /device/start
 *  also has an absolute pending-row cap. */
export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : (fwd ?? '').toString().split(',')[0];
  return (first.trim() || req.ip || req.socket?.remoteAddress || 'unknown').toString();
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Bucket key; defaults to client IP. */
  keyFn?: (req: Request) => string;
  message?: string;
}

/** The default bucket: the client IP, with an IPv6 address reduced to its /64.
 *  A v6 client takes a fresh address out of its /64 whenever it likes, so a
 *  key on the exact address hands each one a private budget. */
function clientKey(req: Request): string {
  return ipKeyGenerator(clientIp(req), 64);
}

/** Fixed-window per-key limiter. Returns 429 once `max` is exceeded within
 *  `windowMs`, with the JSON `error` and a Retry-After header. */
export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const { windowMs, max, keyFn = clientKey, message = 'Too many requests, slow down.' } = opts;
  // The casts cross a typings seam, nothing more: express-rate-limit is typed
  // against the root @types/express while the hub pins its own copy, and the
  // two Request types are structurally identical at runtime.
  const limiter = expressRateLimit({
    windowMs,
    limit: max,
    keyGenerator: (req: any) => keyFn(req as Request),
    standardHeaders: false,
    legacyHeaders: false,
    // clientIp reads X-Forwarded-For itself (see above), so the library's
    // warning about an unexpected X-Forwarded-For without `trust proxy` would
    // fire on every proxied request and describe a decision already made.
    validate: { xForwardedForHeader: false },
    handler: (req: any, res: any) => {
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
