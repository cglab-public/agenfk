import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireAdmin } from '../auth/session.js';
import { requireCiToken } from '../auth/ciToken.js';
import { asyncRoute } from '../util/asyncRoute.js';
import { rateLimit, clientIp } from '../util/rateLimit.js';
import {
  CiError,
  STATUS_FOR_CI_ERROR,
  getReceipt,
  getReceiptReport,
  issueCiToken,
  listCiTokens,
  lookupReceipts,
  revokeCiToken,
} from '../services/ciReceipts.js';

function sendCiError(res: Response, e: unknown): void {
  if (!(e instanceof CiError)) throw e;
  res.status(STATUS_FOR_CI_ERROR[e.code]).json({ error: e.message, code: e.code });
}

/** Admin side: mounted at /v1/admin/ci-tokens, session + admin role on every route. */
export function ciTokensAdminRouter(ctx: HubServerContext): Router {
  const router = Router();
  const guard = requireAdmin(ctx.config.sessionSecret, ctx.db);

  router.get('/', guard, asyncRoute(async (req: Request, res: Response) => {
    res.json({ tokens: await listCiTokens(ctx.db, req.session!.orgId) });
  }));

  router.post('/', guard, asyncRoute(async (req: Request, res: Response) => {
    try {
      const user = await ctx.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [req.session!.userId]);
      const issued = await issueCiToken(ctx.db, req.session!.orgId, req.body ?? {}, user?.email ?? null);
      // The token is shown once, here; the hub keeps only its hash.
      res.status(201).json(issued);
    } catch (e) {
      sendCiError(res, e);
    }
  }));

  router.delete('/:tokenHashPreview', guard, asyncRoute(async (req: Request, res: Response) => {
    const preview = String(req.params.tokenHashPreview);
    // Hex only and at least 8 characters, as for api keys: a '%' would be a
    // LIKE wildcard revoking every CI token of the org (CGLAB-75).
    if (!/^[0-9a-f]{8,64}$/i.test(preview)) {
      res.status(400).json({ error: 'tokenHashPreview must be 8-64 hexadecimal characters — a prefix of the token hash, not a pattern.' });
      return;
    }
    const result = await revokeCiToken(ctx.db, req.session!.orgId, preview);
    if ('ambiguous' in result) {
      res.status(409).json({
        error: `"${preview}" matches ${result.ambiguous} live CI tokens. Use a longer prefix to name just one.`,
        matches: result.ambiguous,
      });
      return;
    }
    res.json(result);
  }));

  return router;
}

/**
 * CI side: mounted at /v1/ci, a `ci_` token on every route, and reads only.
 * Bounded per address before the token costs a database read, then per token:
 * a CI run makes a handful of lookups per job, so the budget is there to make a
 * runaway loop loud rather than to throttle a busy repository.
 */
export function ciRouter(ctx: HubServerContext): Router {
  const router = Router();
  const requireToken = requireCiToken(ctx.db);
  const perAddress = rateLimit({ windowMs: 60 * 1000, max: 600, message: 'Too many CI receipt reads, slow down.' });
  const perToken = rateLimit({
    windowMs: 60 * 1000, max: 300,
    keyFn: (req) => req.hubCiToken?.tokenHash ?? clientIp(req),
    message: 'Too many CI receipt reads, slow down.',
  });

  router.get('/receipts', perAddress, requireToken, perToken, asyncRoute(async (req: Request, res: Response) => {
    try {
      res.json(await lookupReceipts(ctx.db, req.hubCiToken!, req.query));
    } catch (e) {
      sendCiError(res, e);
    }
  }));

  router.get('/receipts/:id', perAddress, requireToken, perToken, asyncRoute(async (req: Request, res: Response) => {
    try {
      res.json(await getReceipt(ctx.db, req.hubCiToken!, String(req.params.id)));
    } catch (e) {
      sendCiError(res, e);
    }
  }));

  router.get('/receipts/:id/report', perAddress, requireToken, perToken, asyncRoute(async (req: Request, res: Response) => {
    try {
      const log = await getReceiptReport(ctx.db, req.hubCiToken!, String(req.params.id));
      res.type('text/plain; charset=utf-8').send(log);
    } catch (e) {
      sendCiError(res, e);
    }
  }));

  return router;
}
