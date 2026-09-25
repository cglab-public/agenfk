import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireAdmin } from '../auth/session.js';
import { requireApiKey } from '../auth/apiKey.js';
import { publicHubUrl } from '../util/publicUrl.js';
import { rateLimit, sessionUserKey, clientIp } from '../util/rateLimit.js';
import { asyncRoute } from '../util/asyncRoute.js';
import {
  MAX_CLIENT_ID_LENGTH,
  MAX_CLIENT_SECRET_LENGTH,
  MAX_RELAY_QUERY_LENGTH,
  JiraRelayError,
  completeJiraOAuth,
  disconnectAllJira,
  disconnectJira,
  getJiraApp,
  getJiraConnection,
  handleJiraCallback,
  isRelayablePath,
  relayJiraGet,
  saveJiraApp,
  startJiraOAuth,
  type JiraConnectionView,
} from '../services/jira.js';

// The URI registered on the org's Atlassian app, and the one every flow uses.
// The hub's canonical public URL (AGENFK_HUB_PUBLIC_URL when set): the admin
// page and each installation's server-to-server start must agree on it even
// when installations joined through a different hostname, or Atlassian
// refuses a redirect_uri that was never registered.
function callbackUrl(req: Request): string {
  return `${publicHubUrl(req)}/v1/jira/oauth/callback`;
}

const STATUS_FOR: Record<JiraRelayError['code'], number> = {
  jira_not_configured: 409,
  jira_not_connected: 409,
  jira_auth_failed: 502,
  jira_unreachable: 502,
  invalid_return_to: 400,
  invalid_completion: 400,
  completion_key_mismatch: 403,
  key_not_personal: 403,
};

/** What an installation may see of its connection: never a token. */
const connectionBody = (c: JiraConnectionView) => ({
  configured: c.configured, connected: c.connected, cloudId: c.cloudId, cloudUrl: c.cloudUrl, email: c.email, lastError: c.lastError,
});

function sendRelayError(res: Response, e: unknown): void {
  if (!(e instanceof JiraRelayError)) throw e;
  res.status(STATUS_FOR[e.code]).json({ error: e.message, code: e.code });
}

/** Admin side: mounted at /v1/admin/jira, session + admin role on every route. */
export function jiraAdminRouter(ctx: HubServerContext): Router {
  const router = Router();
  router.use(rateLimit({
    windowMs: 60 * 1000, max: 120,
    keyFn: sessionUserKey(ctx.config.sessionSecret),
    message: 'Too many requests, slow down.',
  }));
  const guard = requireAdmin(ctx.config.sessionSecret);

  const view = async (req: Request) => ({
    ...(await getJiraApp(ctx.db, req.session!.orgId)),
    redirectUri: callbackUrl(req),
  });

  router.get('/', guard, asyncRoute(async (req: Request, res: Response) => {
    res.json(await view(req));
  }));

  router.put('/', guard, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const { clientId, clientSecret } = req.body ?? {};
    if (typeof clientId !== 'string' || !clientId.trim() || clientId.length > MAX_CLIENT_ID_LENGTH) {
      return res.status(400).json({ error: 'clientId is required' });
    }
    if (clientSecret !== undefined && (typeof clientSecret !== 'string' || clientSecret.length > MAX_CLIENT_SECRET_LENGTH)) {
      return res.status(400).json({ error: 'clientSecret must be a string' });
    }
    const current = await getJiraApp(ctx.db, orgId);
    // A new app needs its own secret: keeping the old app's under a new id
    // would leave a config that can never authorize.
    if ((!current.configured || clientId.trim() !== current.clientId) && !clientSecret) {
      return res.status(400).json({ error: 'clientSecret is required' });
    }
    await saveJiraApp(ctx.db, orgId, {
      clientId: clientId.trim(),
      clientSecret: clientSecret || undefined,
      secretKey: ctx.config.secretKey,
    });
    res.json(await view(req));
  }));

  router.post('/disconnect-all', guard, asyncRoute(async (req: Request, res: Response) => {
    await disconnectAllJira(ctx.db, req.session!.orgId);
    res.json(await view(req));
  }));

  return router;
}

/**
 * Installation side: mounted at /v1/jira. Everything but the browser-facing
 * callback authenticates with the installation's api key, and acts on THAT
 * key's own connection.
 */
export function jiraInstallationRouter(ctx: HubServerContext): Router {
  const router = Router();
  const requireKey = requireApiKey(ctx.db);
  // Ahead of the key lookup, so unauthenticated traffic is bounded before it
  // costs a database read.
  const perAddress = rateLimit({ windowMs: 60 * 1000, max: 600, message: 'Too many JIRA requests, slow down.' });
  // Per key, and per org so N laptops don't get N times the org's Atlassian budget.
  const perKey = rateLimit({
    windowMs: 60 * 1000, max: 300,
    keyFn: (req) => req.hubApiKey?.tokenHash ?? clientIp(req),
    message: 'Too many JIRA requests, slow down.',
  });
  const perOrg = rateLimit({
    windowMs: 60 * 1000, max: 1200,
    keyFn: (req) => `org:${req.hubApiKey?.orgId ?? clientIp(req)}`,
    message: 'Too many JIRA requests for this organisation, slow down.',
  });
  const authed = [perAddress, requireKey, perKey];
  const who = (req: Request) => ({ orgId: req.hubApiKey!.orgId, keyHash: req.hubApiKey!.tokenHash });

  router.get('/status', ...authed, asyncRoute(async (req: Request, res: Response) => {
    const { orgId, keyHash } = who(req);
    res.json(connectionBody(await getJiraConnection(ctx.db, orgId, keyHash)));
  }));

  router.post('/oauth/start', ...authed, asyncRoute(async (req: Request, res: Response) => {
    try {
      const authorizeUrl = await startJiraOAuth(ctx.db, {
        ...who(req),
        installationId: req.hubApiKey!.installationId ?? null,
        returnTo: req.body?.returnTo,
        redirectUri: callbackUrl(req),
        secretKey: ctx.config.secretKey,
      });
      res.json({ authorizeUrl });
    } catch (e) {
      sendRelayError(res, e);
    }
  }));

  // Browser-facing, so no api key: the single-use state is the credential,
  // and nothing is bound here - see completeJiraOAuth.
  router.get('/oauth/callback', perAddress, asyncRoute(async (req: Request, res: Response) => {
    const location = await handleJiraCallback(ctx.db, {
      state: req.query.state,
      code: req.query.code,
      error: req.query.error,
      redirectUri: callbackUrl(req),
      secretKey: ctx.config.secretKey,
    });
    if (!location) {
      return res.status(400).type('text/plain').send('This JIRA connection link is invalid or has expired. Start again from your AgEnFK board.');
    }
    res.redirect(location);
  }));

  router.post('/oauth/complete', ...authed, asyncRoute(async (req: Request, res: Response) => {
    const { orgId, keyHash } = who(req);
    try {
      await completeJiraOAuth(ctx.db, orgId, keyHash, req.body?.completion);
    } catch (e) {
      return sendRelayError(res, e);
    }
    res.json(connectionBody(await getJiraConnection(ctx.db, orgId, keyHash)));
  }));

  router.post('/disconnect', ...authed, asyncRoute(async (req: Request, res: Response) => {
    const { orgId, keyHash } = who(req);
    await disconnectJira(ctx.db, orgId, keyHash);
    res.json(connectionBody(await getJiraConnection(ctx.db, orgId, keyHash)));
  }));

  router.get(/^\/rest\/api\/3\/(.+)$/, ...authed, perOrg, asyncRoute(async (req: Request, res: Response) => {
    const path = (req.params as any)[0] as string;
    // A distinct code: a bare 404 would read, to a client validating a key,
    // exactly like JIRA saying the issue does not exist.
    if (!isRelayablePath(path)) return res.status(404).json({ error: 'Not a relayed JIRA endpoint', code: 'not_relayed' });
    const qIndex = req.originalUrl.indexOf('?');
    const query = qIndex === -1 ? '' : req.originalUrl.slice(qIndex + 1);
    if (query.length > MAX_RELAY_QUERY_LENGTH) return res.status(414).json({ error: 'Query too long' });
    try {
      const r = await relayJiraGet(ctx.db, { ...who(req), secretKey: ctx.config.secretKey, path, query });
      res.status(r.status).json(r.body);
    } catch (e) {
      sendRelayError(res, e);
    }
  }));

  // Everything else under /v1/jira - other API versions, writes, the bare
  // prefix - is refused with the same code as an allow-list miss.
  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not a relayed JIRA endpoint', code: 'not_relayed' });
  });

  return router;
}
