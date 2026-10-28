import { Router, Request, Response, RequestHandler } from 'express';
import { HubServerContext } from '../server.js';
import { asyncRoute } from '../util/asyncRoute.js';
import { withLock } from '../util/withLock.js';
import { AirlockPolicyError } from '../services/airlock.js';
import { acceptAirlockLearning, listAirlockLearning } from '../services/airlockLearning.js';

/**
 * Airlock learning proposals on Admin -> Airlock (GH-294, TEL-3), on the admin
 * router (session + admin role on each route):
 *
 *   GET  /v1/admin/airlock/learning          the hosts installations proposed, one row per host
 *   POST /v1/admin/airlock/learning/accept   allow some of them: the next revision (audited)
 */
const STATUS_FOR: Record<AirlockPolicyError['code'], number> = { invalid_policy: 400, revision_conflict: 409, no_policy: 409 };

export function registerAirlockLearningRoutes(router: Router, ctx: HubServerContext, guard: RequestHandler): void {
  router.get('/learning', guard, asyncRoute(async (req: Request, res: Response) => {
    res.json(await listAirlockLearning(ctx.db, req.session!.orgId));
  }));

  router.post('/learning/accept', guard, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    try {
      const user = await ctx.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [req.session!.userId]);
      res.json(await withLock(`airlock:${orgId}`, () =>
        acceptAirlockLearning(ctx.db, orgId, req.body?.hosts, req.body?.expectedRevision, user?.email ?? null)));
    } catch (e) {
      if (!(e instanceof AirlockPolicyError)) throw e;
      res.status(STATUS_FOR[e.code]).json({ error: e.message, code: e.code, errors: e.errors });
    }
  }));
}
