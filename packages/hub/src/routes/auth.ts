import { Router, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { HubServerContext } from '../server.js';
import {
  countUsers,
  createPasswordUser,
  findUserByEmail,
  recordLogin,
  verifyPassword,
} from '../auth/password.js';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  requireSession,
  setSessionCookie,
  signSession,
} from '../auth/session.js';
import { rateLimit, FailedAttemptTracker, sessionUserKey } from '../util/rateLimit.js';
import { asyncRoute } from '../util/asyncRoute.js';
import { redeemAdminRecoveryToken } from '../auth/adminRecovery.js';

// Brute-force defences for password login (Security: bug 210b3d34):
//  - per-IP rate limit so one source can't fire unlimited attempts
//  - per-account lockout so a slow distributed attack still trips a wall
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

interface AuthConfigRow {
  password_enabled: number;
  google_enabled: number;
  entra_enabled: number;
}

export function authRouter(ctx: HubServerContext): Router {
  const router = Router();
  // Per-hub-instance state (not module-level) so each process/app has its own
  // counters and tests stay isolated.
  const loginRateLimit = rateLimit({ windowMs: LOGIN_WINDOW_MS, max: 20, message: 'Too many login attempts, try again later.' });
  // /auth/me is authenticated AND hits the database on every call, so it needs
  // a bound. Deliberately NOT keyed by IP: the hub sits behind a corporate
  // egress where every user shares one, and the UI calls this on each page
  // load — an IP bucket would be an org-wide cap, not a per-caller one. Keyed
  // by the VERIFIED session user, like /v1 and /v1/admin. It used to key on
  // the raw cookie string, so every forged value minted a bucket kept for the
  // window: memory that grew per request and a limit that never refused.
  const meRateLimit = rateLimit({
    windowMs: LOGIN_WINDOW_MS,
    max: 300,
    keyFn: sessionUserKey(ctx.config.sessionSecret),
    message: 'Too many requests, slow down.',
  });
  const loginFailures = new FailedAttemptTracker(/* maxFailures */ 5, LOGIN_WINDOW_MS, /* lockMs */ LOGIN_WINDOW_MS);

  router.get('/providers', asyncRoute(async (_req: Request, res: Response) => {
    const cfg = await ctx.db.get<AuthConfigRow>(
      'SELECT password_enabled, google_enabled, entra_enabled FROM auth_config WHERE org_id = ?',
      [ctx.config.defaultOrgId],
    );
    res.json({
      password: !!cfg?.password_enabled || !!ctx.config.forcePasswordLogin,
      google: !!cfg?.google_enabled,
      entra: !!cfg?.entra_enabled,
      requiresSetup: (await countUsers(ctx.db)) === 0,
    });
  }));

  router.post('/login', loginRateLimit, asyncRoute(async (req: Request, res: Response) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email and password required' });
    }

    // "Email + password" switched off in Admin → Sign-in must actually stop
    // password sign-in, not just hide the form. Checked before the account is
    // looked up, so the answer is the same for every email and cannot be used
    // to find accounts, and a refused attempt does not count towards lockout.
    // A missing row fails closed, as /auth/providers and the SSO routes do:
    // boot seeds the default org's row with password on, so it goes missing
    // only when this process's defaultOrgId is stale (an org rename on another
    // replica), and then nothing should be accepted against the wrong org.
    // The hub is single-tenant (v1): the default org's setting governs every
    // password sign-in, like the other sign-in routes.
    const cfg = await ctx.db.get<Pick<AuthConfigRow, 'password_enabled'>>(
      'SELECT password_enabled FROM auth_config WHERE org_id = ?',
      [ctx.config.defaultOrgId],
    );
    // AGENFK_HUB_FORCE_PASSWORD_LOGIN is the operator's way back in when SSO
    // has broken with password switched off (see HubServerConfig).
    if (!ctx.config.forcePasswordLogin && (!cfg || !Number(cfg.password_enabled))) {
      return res.status(403).json({ error: 'Password sign-in is not enabled' });
    }

    // Account lockout: too many recent failures for this email → refuse without
    // even hitting the password hash, regardless of source IP. (bug 210b3d34.)
    if (loginFailures.isLocked(email)) {
      return res.status(429).json({ error: 'Account temporarily locked due to repeated failed logins. Try again later.' });
    }

    const user = await findUserByEmail(ctx.db, email);

    if (!user || !user.password_hash || !user.active) {
      loginFailures.recordFailure(email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // One SSO sign-in moves a password account to google/entra (oauth.ts
    // findInvitedSsoUser) while keeping its hash. Under the break-glass an
    // ADMIN's hash is accepted: the operator needs back in precisely when SSO
    // broke. Everyone else keeps to the provider they moved to.
    if (user.provider !== 'password' && !(ctx.config.forcePasswordLogin && user.role === 'admin')) {
      return res.status(401).json({ error: `This account signs in with ${user.provider}` });
    }
    if (!verifyPassword(password, user.password_hash)) {
      loginFailures.recordFailure(email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    loginFailures.clear(email);
    await recordLogin(ctx.db, user.id);
    const token = signSession({ userId: user.id, orgId: user.org_id, role: user.role }, ctx.config.sessionSecret);
    setSessionCookie(res, token);
    res.json({ id: user.id, email: user.email, role: user.role, orgId: user.org_id });
  }));

  // Admin recovery (STORY a44f3697): the token a boot logged for the admin
  // AGENFK_HUB_RESET_ADMIN_EMAIL names. Deliberately ahead of the sign-in
  // settings - it exists for when they lock everyone out.
  const recoverRateLimit = rateLimit({ windowMs: LOGIN_WINDOW_MS, max: 20, message: 'Too many recovery attempts, try again later.' });
  router.post('/recover', recoverRateLimit, asyncRoute(async (req: Request, res: Response) => {
    const { token, password } = req.body ?? {};
    const out = await redeemAdminRecoveryToken(ctx.db, ctx.config.defaultOrgId, token, password);
    if ('status' in out) return res.status(out.status).json({ error: out.error });
    const user = out.user;
    await recordLogin(ctx.db, user.id);
    setSessionCookie(res, signSession({ userId: user.id, orgId: user.org_id, role: user.role }, ctx.config.sessionSecret));
    console.warn(`[HUB] Admin recovery: ${user.email} signed in with a recovery token and set a new password.`);
    res.json({ id: user.id, email: user.email, role: user.role, orgId: user.org_id });
  }));

  router.post('/logout', (_req: Request, res: Response) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', meRateLimit, requireSession(ctx.config.sessionSecret, ctx.db), asyncRoute(async (req: Request, res: Response) => {
    // The session cookie carries ids only. Who the user actually IS — their
    // name and email — lives in the row, and the identity provider can change
    // the name between sign-ins, so read it rather than bake it into the JWT.
    // requireSession has already refused a deleted or deactivated user, so the
    // row is there; the fallbacks only cover a delete landing in between.
    const row = await ctx.db.get<{ email: string; name: string | null }>(
      'SELECT email, name FROM users WHERE id = ?',
      [req.session!.userId],
    );
    res.json({ ...req.session, email: row?.email ?? null, name: row?.name ?? null });
  }));

  return router;
}

/** The bootstrap token was consumed by another request after this one read it. */
class SetupAlreadyClaimed extends Error {}

export function setupRouter(ctx: HubServerContext): Router {
  const router = Router();
  // Unauthenticated, and it creates an admin. The token is a UUIDv4, so this
  // bounds probing rather than preventing a brute force that could not work.
  const setupRateLimit = rateLimit({ windowMs: LOGIN_WINDOW_MS, max: 20, message: 'Too many setup attempts, try again later.' });

  router.post('/initial-admin', setupRateLimit, asyncRoute(async (req: Request, res: Response) => {
    if ((await countUsers(ctx.db)) > 0) {
      return res.status(409).json({ error: 'Setup is closed: an admin already exists.' });
    }
    const { token, email, password } = req.body ?? {};

    // Token check first — single generic 401 for missing/empty/wrong, so a
    // probe can't tell the difference between "no token row" and "wrong
    // token". Constant-time compare on equal-length buffers.
    const stored = await ctx.db.get<{ token: string }>('SELECT token FROM bootstrap_tokens LIMIT 1');
    const ok = (() => {
      if (!stored?.token) return false;
      if (typeof token !== 'string' || token.length === 0) return false;
      const a = Buffer.from(stored.token, 'utf8');
      const b = Buffer.from(token, 'utf8');
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    })();
    if (!ok) {
      return res.status(401).json({ error: 'Invalid token or setup is closed' });
    }

    if (typeof email !== 'string' || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'email + password (≥8 chars) required' });
    }

    // Consume THIS token, then create the admin, in one transaction. The
    // checks above ran outside it, so a concurrent request holding the same
    // token may have claimed setup since: only the request whose DELETE
    // removed the row may create an admin. If user creation throws (e.g. a
    // UNIQUE collision on email), the token is rolled back so the operator
    // can retry.
    try {
      await ctx.db.transaction(async () => {
        const consumed = await ctx.db.run('DELETE FROM bootstrap_tokens WHERE token = ?', [token]);
        if (consumed.changes !== 1) throw new SetupAlreadyClaimed();
        // Any other token row (two hub tasks booting at once can each insert
        // one) would be a second key to an admin account. On Postgres a racer
        // holding it now waits on this DELETE and finds nothing once we commit.
        await ctx.db.run('DELETE FROM bootstrap_tokens', []);
        await createPasswordUser(ctx.db, ctx.config.defaultOrgId, email, password, 'admin');
      });
    } catch (err) {
      if (err instanceof SetupAlreadyClaimed) {
        return res.status(409).json({ error: 'Setup is closed: an admin already exists.' });
      }
      throw err;
    }
    res.status(201).json({ ok: true });
  }));

  return router;
}
export { SESSION_COOKIE };
