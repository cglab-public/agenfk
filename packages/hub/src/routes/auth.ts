import { Router, Request, Response } from 'express';
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

interface AuthConfigRow {
  password_enabled: number;
  google_enabled: number;
  entra_enabled: number;
}

export function authRouter(ctx: HubServerContext): Router {
  const router = Router();

  router.get('/providers', (_req: Request, res: Response) => {
    const cfg = ctx.db
      .prepare('SELECT password_enabled, google_enabled, entra_enabled FROM auth_config WHERE org_id = ?')
      .get(ctx.config.defaultOrgId) as AuthConfigRow | undefined;
    res.json({
      password: !!cfg?.password_enabled,
      google: !!cfg?.google_enabled,
      entra: !!cfg?.entra_enabled,
      requiresSetup: countUsers(ctx.db) === 0,
    });
  });

  router.post('/login', (req: Request, res: Response) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email and password required' });
    }

    let user = findUserByEmail(ctx.db, email);

    // Initial-admin bootstrap: when users table is empty AND env-supplied admin
    // creds match the login attempt, lazily create the seeded admin row. The
    // env vars become inert as soon as the row exists.
    if (!user && countUsers(ctx.db) === 0
      && ctx.config.initialAdminEmail
      && ctx.config.initialAdminPassword
      && email.toLowerCase() === ctx.config.initialAdminEmail.toLowerCase()
      && password === ctx.config.initialAdminPassword) {
      user = createPasswordUser(ctx.db, ctx.config.defaultOrgId, email, password, 'admin');
    }

    if (!user || !user.password_hash || !user.active) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.provider !== 'password') {
      return res.status(401).json({ error: `This account signs in with ${user.provider}` });
    }
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    recordLogin(ctx.db, user.id);
    const token = signSession({ userId: user.id, orgId: user.org_id, role: user.role }, ctx.config.sessionSecret);
    setSessionCookie(res, token);
    res.json({ id: user.id, email: user.email, role: user.role, orgId: user.org_id });
  });

  router.post('/logout', (_req: Request, res: Response) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', requireSession(ctx.config.sessionSecret), (req: Request, res: Response) => {
    res.json(req.session);
  });

  return router;
}

export function setupRouter(ctx: HubServerContext): Router {
  const router = Router();

  router.post('/initial-admin', (req: Request, res: Response) => {
    if (countUsers(ctx.db) > 0) {
      return res.status(409).json({ error: 'Setup is closed: an admin already exists.' });
    }
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'email + password (≥8 chars) required' });
    }
    createPasswordUser(ctx.db, ctx.config.defaultOrgId, email, password, 'admin');
    res.status(201).json({ ok: true });
  });

  return router;
}
export { SESSION_COOKIE };
