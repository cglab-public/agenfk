import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireAdmin } from '../auth/session.js';
import { requireApiKey } from '../auth/apiKey.js';
import { asyncRoute } from '../util/asyncRoute.js';
import { rateLimit, clientIp } from '../util/rateLimit.js';
import { withLock } from '../util/withLock.js';
import {
  AirlockPolicyError,
  airlockEtagOf,
  getAirlockPolicy,
  putAirlockIocHosts,
  putAirlockPolicy,
} from '../services/airlock.js';

/**
 * Airlock (GH-294, T3): the org's policy, kept on the hub.
 *
 *   GET /v1/airlock/policy       the installation's read (api key), ETag + 304
 *   GET /v1/admin/airlock        the admin's read
 *   PUT /v1/admin/airlock        the admin's save of the policy
 *   PUT /v1/admin/airlock/ioc    the admin's save of the IOC host list
 *
 * The org always comes from the credential (the api key or the session), never
 * from the body, so one org can neither read nor write another's policy.
 */

/** The admin routes' request size: a policy with every list at its cap fits well inside it. */
export const AIRLOCK_ADMIN_BODY_LIMIT = '256kb';

const STATUS_FOR: Record<AirlockPolicyError['code'], number> = {
  invalid_policy: 400,
  revision_conflict: 409,
  no_policy: 409,
};

function sendAirlockError(res: Response, e: unknown): void {
  if (!(e instanceof AirlockPolicyError)) throw e;
  res.status(STATUS_FOR[e.code]).json({ error: e.message, code: e.code, errors: e.errors });
}

/** Installation side: mounted at /v1, authenticated by the installation's api key. */
export function airlockRouter(ctx: HubServerContext): Router {
  const router = Router();
  const requireKey = requireApiKey(ctx.db);
  const perAddress = rateLimit({ windowMs: 60 * 1000, max: 600, message: 'Too many Airlock requests, slow down.' });
  const perKey = rateLimit({
    windowMs: 60 * 1000, max: 300,
    keyFn: (req) => req.hubApiKey?.tokenHash ?? clientIp(req),
    message: 'Too many Airlock requests, slow down.',
  });

  router.get('/airlock/policy', perAddress, requireKey, perKey, asyncRoute(async (req: Request, res: Response) => {
    const view = await getAirlockPolicy(ctx.db, req.hubApiKey!.orgId);
    const etag = airlockEtagOf(view);
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.json({ policy: view.policy, revision: view.revision, iocRevision: view.iocRevision });
  }));

  return router;
}

/** The signed-in admin's email, for the row that names who saved it. */
async function emailOf(ctx: HubServerContext, req: Request): Promise<string | null> {
  const user = await ctx.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [req.session!.userId]);
  return user?.email ?? null;
}

/** Admin side: mounted at /v1/admin/airlock, session + admin role on every route. */
export function airlockAdminRouter(ctx: HubServerContext): Router {
  const router = Router();
  const guard = requireAdmin(ctx.config.sessionSecret, ctx.db);

  router.get('/', guard, asyncRoute(async (req: Request, res: Response) => {
    res.json(await getAirlockPolicy(ctx.db, req.session!.orgId));
  }));

  // One save of one org's policy at a time in this process; the transaction in
  // the service is what keeps it correct across processes.
  router.put('/', guard, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    try {
      const email = await emailOf(ctx, req);
      res.json(await withLock(`airlock:${orgId}`, () =>
        putAirlockPolicy(ctx.db, orgId, req.body?.policy, req.body?.expectedRevision, email)));
    } catch (e) {
      sendAirlockError(res, e);
    }
  }));

  router.put('/ioc', guard, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    try {
      const email = await emailOf(ctx, req);
      res.json(await withLock(`airlock:${orgId}`, () => putAirlockIocHosts(ctx.db, orgId, req.body?.hosts, email)));
    } catch (e) {
      sendAirlockError(res, e);
    }
  }));

  return router;
}
