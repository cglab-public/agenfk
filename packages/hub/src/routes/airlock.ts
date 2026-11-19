import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireAdmin } from '../auth/session.js';
import { requireApiKey } from '../auth/apiKey.js';
import { asyncRoute } from '../util/asyncRoute.js';
import { rateLimit, clientIp } from '../util/rateLimit.js';
import { withLock } from '../util/withLock.js';
import { decodeCursor } from '../services/configAudit.js';
import {
  AIRLOCK_ALERTS,
  AIRLOCK_MODES,
  AIRLOCK_SOURCES,
  AirlockPolicyError,
  MAX_DECISION_CURSOR_CHARS,
  airlockEtagOf,
  getAirlockPolicy,
  listAirlockDecisions,
  listAirlockHistory,
  listAirlockInstallations,
  putAirlockIocHosts,
  putAirlockPolicy,
} from '../services/airlock.js';
import { registerAirlockLearningRoutes } from './airlockLearning.js';
import {
  AirlockDatasetError,
  airlockDatasetEnabled,
  exportAirlockDataset,
  getAirlockDatasetView,
  setAirlockDatasetEnabled,
  writeLines,
} from '../services/airlockDataset.js';

/**
 * Airlock (GH-294, T3): the org's policy, kept on the hub.
 *
 *   GET /v1/airlock/policy       the installation's read (api key), ETag + 304
 *   GET /v1/admin/airlock        the admin's read
 *   PUT /v1/admin/airlock        the admin's save of the policy
 *   PUT /v1/admin/airlock/ioc    the admin's save of the IOC host list
 *   GET /v1/admin/airlock/installations   each installation's applied revision (HUB-2)
 *   GET /v1/admin/airlock/history         the policy's revisions, from the config audit
 *   GET /v1/admin/airlock/decisions       the org's recent denials and alerts (HUB-1)
 *   GET|PUT /v1/admin/airlock/dataset     the dataset switch (off by default) and what it holds (DS-2)
 *   GET /v1/admin/airlock/dataset/export  the dataset as JSONL of Clef records
 *
 * The installation's read carries the dataset switch, so it sends rows only
 * while an admin has it on; its ETag carries it too.
 *
 * What an installation applies, and what it denied, arrive through its event
 * stream (`airlock.policy-applied` / `airlock.policy-refused` /
 * `airlock.decision`, routes/events.ts).
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
    const orgId = req.hubApiKey!.orgId;
    const [view, dataset] = await Promise.all([getAirlockPolicy(ctx.db, orgId), airlockDatasetEnabled(ctx.db, orgId)]);
    const etag = airlockEtagOf(view, dataset);
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.json({ policy: view.policy, revision: view.revision, iocRevision: view.iocRevision, dataset: { enabled: dataset } });
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

  router.get('/installations', guard, asyncRoute(async (req: Request, res: Response) => {
    res.json(await listAirlockInstallations(ctx.db, req.session!.orgId));
  }));

  router.get('/history', guard, asyncRoute(async (req: Request, res: Response) => {
    const limit = Number(req.query.limit);
    res.json(await listAirlockHistory(ctx.db, req.session!.orgId, {
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
    }));
  }));

  // Filters: client, installation, source, alert (a category or 'any'), mode;
  // an unknown value for one with a fixed set is refused rather than ignored,
  // so a typo does not read as "nothing happened".
  router.get('/decisions', guard, asyncRoute(async (req: Request, res: Response) => {
    const q = (name: string): string | undefined => {
      const v = req.query[name];
      return typeof v === 'string' && v.length > 0 ? v.slice(0, 200) : undefined;
    };
    const known = <T extends string>(name: string, list: readonly T[]): T | undefined | null => {
      const v = q(name);
      if (v === undefined) return undefined;
      return (list as readonly string[]).includes(v) ? v as T : null;
    };
    const source = known('source', AIRLOCK_SOURCES);
    const alert = known('alert', [...AIRLOCK_ALERTS, 'any'] as const);
    const mode = known('mode', AIRLOCK_MODES);
    if (source === null || alert === null || mode === null) {
      return res.status(400).json({ error: 'source, alert and mode take one of their known values' });
    }
    // A cursor is only ever one this route handed out: anything else is refused,
    // not read as "from the top", which would serve page one again as page two.
    const rawCursor = req.query.cursor;
    let cursor: string | undefined;
    if (rawCursor !== undefined) {
      if (typeof rawCursor !== 'string' || rawCursor.length > MAX_DECISION_CURSOR_CHARS || !decodeCursor(rawCursor)) {
        return res.status(400).json({ error: 'cursor is not one this list handed out' });
      }
      cursor = rawCursor;
    }
    const limit = Number(req.query.limit);
    res.json(await listAirlockDecisions(ctx.db, req.session!.orgId, {
      client: q('client'),
      installation: q('installation'),
      source, alert, mode,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      cursor,
    }));
  }));

  router.get('/dataset', guard, asyncRoute(async (req: Request, res: Response) => {
    res.json(await getAirlockDatasetView(ctx.db, req.session!.orgId));
  }));

  router.put('/dataset', guard, asyncRoute(async (req: Request, res: Response) => {
    try {
      res.json(await setAirlockDatasetEnabled(ctx.db, req.session!.orgId, req.body?.enabled, await emailOf(ctx, req)));
    } catch (e) {
      if (!(e instanceof AirlockDatasetError)) throw e;
      res.status(400).json({ error: e.message });
    }
  }));

  // Streamed a page at a time: the table can hold its cap of rows.
  router.get('/dataset/export', guard, asyncRoute(async (req: Request, res: Response) => {
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="airlock-dataset-${day}.jsonl"`);
    res.setHeader('Cache-Control', 'no-store');
    await writeLines(res, exportAirlockDataset(ctx.db, req.session!.orgId));
    if (!res.destroyed) res.end();
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

  // Learning proposals (TEL-3): routes/airlockLearning.ts.
  registerAirlockLearningRoutes(router, ctx, guard);

  return router;
}
