import { Request, Response, NextFunction } from 'express';

// Dependency-free, in-memory rate limiting + brute-force lockout for the hub.
// The hub is a single Node process backed by SQLite, so a per-process fixed
// window is sufficient and avoids pulling a new package into a security PR.
// (Security: bugs 210b3d34, 72f8da10.)

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

interface Window { count: number; resetAt: number; }

/** Fixed-window per-key limiter. Returns 429 once `max` is exceeded within
 *  `windowMs`. Stale windows are pruned lazily on each hit. */
export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, keyFn = clientIp, message = 'Too many requests, slow down.' } = opts;
  const windows = new Map<string, Window>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = keyFn(req);
    // Opportunistic prune so the map can't grow unbounded under churn.
    if (windows.size > 10_000) {
      for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
    }
    let w = windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      windows.set(key, w);
    }
    w.count++;
    if (w.count > max) {
      const retryAfter = Math.max(1, Math.ceil((w.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
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
