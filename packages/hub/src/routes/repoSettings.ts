import { Router, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { HubServerContext } from '../server.js';
import { requireAdmin } from '../auth/session.js';
import { requireApiKey } from '../auth/apiKey.js';
import { asyncRoute } from '../util/asyncRoute.js';
import { rateLimit, clientIp } from '../util/rateLimit.js';
import { withLock } from '../util/withLock.js';
import {
  RepoSettingsError,
  getRepoSettings,
  initRepoCommand,
  listRepoSettings,
  listRevisions,
  reviseRepoCommand,
  setProducer,
  setProducerMode,
  setReceiptsMode,
} from '../services/repoSettings.js';
import { lastReceiptTimes, listRepoReceipts } from '../services/ciReceipts.js';

/**
 * Repository settings (RFC-002): the org's authoritative verify command per
 * repository, its revision history, the CI receipts mode and the producer
 * allowlist.
 *
 * Two routers, because two callers read very different things:
 * `repoSettingsRouter` is the installation's read (and its one-shot claim of
 * the command); `repoSettingsAdminRouter` is the board's administration of it.
 *
 * The org always comes from the credential on the request — the api key or the
 * session — never from the body. The repo is canonicalised on every route, so
 * one repository is one record whatever spelling a caller sends.
 */

/** A refused change reads as its code, so a client can branch on it. */
const STATUS_FOR: Record<RepoSettingsError['code'], number> = {
  invalid_repo: 400,
  invalid_command: 400,
  machine_specific_path: 400,
  invalid_mode: 400,
  invalid_threshold: 400,
  invalid_producer_mode: 400,
  unknown_installation: 400,
  threshold_required: 400,
  not_found: 404,
};

function sendRepoError(res: Response, e: unknown): void {
  if (!(e instanceof RepoSettingsError)) throw e;
  res.status(STATUS_FOR[e.code]).json({ error: e.message, code: e.code });
}

/** The repo a request means: the `repo` query param on a read, the body's on a write. */
const repoQuery = (req: Request): unknown => req.query.repo;

/**
 * A weak entity tag over everything the installation caches. Kept by hand, like
 * /v1/flows/active: it must bust when the command, the mode, the threshold, the
 * producer mode or the producer list moves, and none of those is a version of a
 * single row.
 *
 * The producer list goes in as its contents, not its length: swap one
 * installation for another and the count is unchanged while the allowlist an
 * installation would keep serving from its cache is not. Hashed because a
 * header is no place for an unbounded list, and a collision only costs one
 * extra 200.
 */
const etagOf = (s: {
  revision: number; receiptsMode: string; shadowThreshold: number | null; producerMode: string; producers: string[];
}) => {
  const digest = createHash('sha256')
    .update(`${s.revision}:${s.receiptsMode}:${s.shadowThreshold ?? '-'}:${s.producerMode}:${s.producers.join(',')}`)
    .digest('hex')
    .slice(0, 16);
  return `W/"${digest}"`;
};

/** Installation side: mounted at /v1, authenticated by the installation's api key. */
export function repoSettingsRouter(ctx: HubServerContext): Router {
  const router = Router();
  const requireKey = requireApiKey(ctx.db);
  // Bounded before the key lookup costs a database read, then per key.
  const perAddress = rateLimit({ windowMs: 60 * 1000, max: 600, message: 'Too many repository requests, slow down.' });
  const perKey = rateLimit({
    windowMs: 60 * 1000, max: 300,
    keyFn: (req) => req.hubApiKey?.tokenHash ?? clientIp(req),
    message: 'Too many repository requests, slow down.',
  });
  const authed = [perAddress, requireKey, perKey];

  router.get('/repo-settings', ...authed, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.hubApiKey!.orgId;
    let settings;
    try {
      settings = await getRepoSettings(ctx.db, orgId, repoQuery(req));
    } catch (e) {
      return sendRepoError(res, e);
    }
    if (!settings) return res.json({ settings: null });
    const etag = etagOf(settings);
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.json({ settings });
  }));

  // The one claim an installation gets: first writer wins, and the record is
  // never overwritten afterwards — not by a losing installation, not by an
  // installation that talks to the hub again after an admin revised it.
  router.post('/repo-settings/init', ...authed, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.hubApiKey!.orgId;
    const installationId = req.hubApiKey!.installationId ?? null;
    // An org-wide key (no installation bound) is shareable by design — a CI key,
    // a script. It must not be able to decide how a repository is verified.
    if (!installationId) {
      return res.status(403).json({ error: 'This call needs an api key bound to an installation', code: 'installation_key_required' });
    }
    let result;
    try {
      result = await initRepoCommand(ctx.db, orgId, req.body?.repo, req.body?.verifyCommand, installationId);
    } catch (e) {
      return sendRepoError(res, e);
    }
    res.status(result.created ? 201 : 200).json({ settings: result.settings, created: result.created });
  }));

  return router;
}

/** The signed-in admin's email, for a row that names who did it. */
async function emailOf(ctx: HubServerContext, req: Request): Promise<string | undefined> {
  const user = await ctx.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [req.session!.userId]);
  return user?.email;
}

/** Admin side: mounted at /v1/admin/repos, session + admin role on every route. */
export function repoSettingsAdminRouter(ctx: HubServerContext): Router {
  const router = Router();
  const guard = requireAdmin(ctx.config.sessionSecret, ctx.db);

  router.get('/', guard, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const last = await lastReceiptTimes(ctx.db, orgId);
    const repos = await listRepoSettings(ctx.db, orgId);
    res.json({ repos: repos.map(r => ({ ...r, lastReceiptAt: last.get(r.remoteUrl) ?? null })) });
  }));

  // The repository's recent receipts, for the admin to see which can be reused and why not.
  router.get('/receipts', guard, asyncRoute(async (req: Request, res: Response) => {
    try {
      res.json({ receipts: await listRepoReceipts(ctx.db, req.session!.orgId, repoQuery(req)) });
    } catch (e) {
      sendRepoError(res, e);
    }
  }));

  // Every route below names the repository it changes; a repo that is not a
  // usable remote is refused the same way whether the read or the write asks.

  router.get('/revisions', guard, asyncRoute(async (req: Request, res: Response) => {
    try {
      res.json({ revisions: await listRevisions(ctx.db, req.session!.orgId, repoQuery(req)) });
    } catch (e) {
      sendRepoError(res, e);
    }
  }));

  router.put('/command', guard, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    try {
      // The session proves the user id; their email is read from their row, so
      // the history names the person rather than an id, and never a stale one.
      const actor = await ctx.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [req.session!.userId]);
      // One revision of one repository is written at a time, and `withLock`
      // gives that for free on the deployment this hub runs on: a single
      // process, whose requests all pass through this middleware. It is not
      // what makes the write correct — the transaction inside the service is,
      // and it has to settle this on its own the moment the hub ever runs more
      // than one process. What the lock buys is that two admins saving at the
      // same moment are served one after the other, so the second one reads the
      // first one's revision instead of racing it.
      const view = await withLock(`repo-command:${orgId}`, () =>
        reviseRepoCommand(ctx.db, orgId, req.body?.repo, req.body?.verifyCommand, {
          userId: req.session!.userId,
          email: actor?.email ?? null,
        }));
      res.json(view);
    } catch (e) {
      sendRepoError(res, e);
    }
  }));

  router.put('/mode', guard, asyncRoute(async (req: Request, res: Response) => {
    try {
      res.json(await setReceiptsMode(ctx.db, req.session!.orgId, req.body?.repo, {
        mode: req.body?.mode,
        shadowThreshold: req.body?.shadowThreshold,
      }));
    } catch (e) {
      sendRepoError(res, e);
    }
  }));

  // Who may produce receipts: the allowlist below, or every live installation
  // of the org (RFC-002 Amendment 1). The allowlist itself is left as it is.
  router.put('/producer-mode', guard, asyncRoute(async (req: Request, res: Response) => {
    try {
      res.json(await setProducerMode(ctx.db, req.session!.orgId, req.body?.repo, req.body?.producerMode));
    } catch (e) {
      sendRepoError(res, e);
    }
  }));

  router.put('/producers', guard, asyncRoute(async (req: Request, res: Response) => {
    try {
      res.json(await setProducer(
        ctx.db,
        req.session!.orgId,
        req.body?.repo,
        req.body?.installationId,
        req.body?.allowed === true,
        (await emailOf(ctx, req)) ?? null,
      ));
    } catch (e) {
      sendRepoError(res, e);
    }
  }));

  return router;
}
