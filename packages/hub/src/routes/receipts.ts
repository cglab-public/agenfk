import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireApiKey } from '../auth/apiKey.js';
import { asyncRoute } from '../util/asyncRoute.js';
import { rateLimit, clientIp } from '../util/rateLimit.js';
import {
  DEFAULT_REPORT_MAX_BYTES,
  ReceiptError,
  STATUS_FOR_RECEIPT_ERROR,
  storeReceipt,
} from '../services/receipts.js';

/**
 * How big a gzipped report this hub keeps, in bytes (RFC-002).
 *
 * Exported because the client side has the same cap for the same reason: a
 * producer that knows the number sends `{ omitted: 'over_cap' }` instead of
 * megabytes over the wire, and gets the same `report_over_cap` either way.
 * Read from the config on every request, never captured at boot — `ctx.config`
 * is live (an org rename moves `defaultOrgId` in it at runtime), and a test
 * that boots a hub with a tiny cap must not need a different route.
 */
export const reportCapOf = (ctx: HubServerContext): number =>
  ctx.config.receiptReportMaxBytes ?? DEFAULT_REPORT_MAX_BYTES;

/**
 * Receipts (RFC-002, task 0334a5e6): the installation's write of a receipt the
 * hub keeps for everyone else.
 *
 * One route, and deliberately no read: a receipt is written by the machine that
 * certified the tree and read by whoever decides whether to trust a run they
 * did not watch — which is a question the board answers through queries, not by
 * pulling its own receipt store. So this file is only about getting a claim
 * in durably, once, without ever overwriting one.
 *
 * The organisation and the producer both come from the credential on the
 * request, never from the body: an api key bound to no installation is refuse
 * (`installation_key_required`), because a shareable CI key is not one machine
 * and cannot be a producer of a claim about a machine. The body's own idea of
 * who published it is not read at all. Everything else — validation, the
 * write-once decision, reusability — is the service's, so the store behaves the
 * same however the route is reached.
 */
export function receiptsRouter(ctx: HubServerContext): Router {
  const router = Router();
  const requireKey = requireApiKey(ctx.db);
  // Bounded before the key lookup costs a database read, then per key. A
  // receipt is one write per certified close, so the per-key budget is far
  // above what an honest installation does in a minute — its job is to make a
  // runaway retry loop loud rather than to throttle real work.
  const perAddress = rateLimit({ windowMs: 60 * 1000, max: 600, message: 'Too many receipt submissions, slow down.' });
  const perKey = rateLimit({
    windowMs: 60 * 1000, max: 120,
    keyFn: (req) => req.hubApiKey?.tokenHash ?? clientIp(req),
    message: 'Too many receipt submissions, slow down.',
  });

  router.post('/receipts', perAddress, requireKey, perKey, asyncRoute(async (req: Request, res: Response) => {
    const key = req.hubApiKey!;
    const installationId = key.installationId ?? null;
    if (!installationId) {
      return res.status(403).json({
        error: 'A receipt names the machine that ran the command, so it needs an api key bound to an installation',
        code: 'installation_key_required',
      });
    }
    try {
      // `reportCap`, not the config inline: the cap is ONE number shared by the
      // route's decision and the client's own choice of whether to send the log
      // at all, and it is exported so the two cannot drift.
      const result = await storeReceipt(
        ctx.db,
        key.orgId,
        installationId,
        req.body,
        reportCapOf(ctx),
      );
      // 201 for the row this request made, 200 for a retry of one already there.
      res.status(result.stored === 'new' ? 201 : 200).json(result);
    } catch (e) {
      if (!(e instanceof ReceiptError)) throw e;
      res.status(STATUS_FOR_RECEIPT_ERROR[e.code]).json({ error: e.message, code: e.code });
    }
  }));

  return router;
}
