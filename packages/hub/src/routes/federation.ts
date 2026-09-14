import { Router, Request, Response } from 'express';
import { randomBytes, randomUUID } from 'crypto';
import { HubServerContext } from '../server.js';
import { requireAdmin } from '../auth/session.js';
import { signInviteToken, verifyInviteToken, INVITE_TTL_MS } from '../auth/inviteToken.js';
import { semverOrNull } from '../util/semver.js';
import { issueFederationKey, requireFederationKey } from '../auth/federationKey.js';
import { publicHubUrl } from '../util/publicUrl.js';

// Hub federation, parent side (CGLAB-181). A child hub enrolls by redeeming an
// admin-issued invite of kind 'child-hub', then heartbeats and polls for
// directives with the federation key it received. Two routers are exported
// because the enrollment invite lives under the session-guarded /hub prefix
// (next to the installation invite) while the child-facing API lives under
// /v1 like every other machine-to-machine route.

const MAX_NAME_LEN = 120;

/** Admin-facing: mint a child-hub invite. Mounted under /hub/federation. */
export function federationInviteRouter(ctx: HubServerContext): Router {
  const router = Router();
  const adminGuard = requireAdmin(ctx.config.sessionSecret);

  router.post('/invite/create', adminGuard, (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const nonce = randomBytes(18).toString('base64url');
    const exp = Date.now() + INVITE_TTL_MS;
    const inviteToken = signInviteToken({ orgId, nonce, exp, kind: 'child-hub' }, ctx.config.secretKey);
    res.json({
      inviteToken,
      parentUrl: publicHubUrl(req),
      expiresAt: new Date(exp).toISOString(),
    });
  });

  return router;
}

/** Child-facing: enroll, heartbeat, poll directives. Mounted under /v1/federation. */
export function federationRouter(ctx: HubServerContext): Router {
  const router = Router();
  const requireKey = requireFederationKey(ctx.db);

  router.post('/enroll', async (req: Request, res: Response) => {
    const inviteToken = String(req.body?.inviteToken ?? '');
    if (!inviteToken) { res.status(400).json({ error: 'inviteToken required' }); return; }
    const parsed = verifyInviteToken(inviteToken, ctx.config.secretKey, 'child-hub');
    if (!parsed) { res.status(400).json({ error: 'invalid invite token' }); return; }
    if (parsed.exp < Date.now()) { res.status(400).json({ error: 'invite token expired' }); return; }

    const rawName = req.body?.childHub?.name;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || name.length > MAX_NAME_LEN) { res.status(400).json({ error: 'childHub.name required' }); return; }
    const hubVersion = semverOrNull(req.body?.childHub?.hubVersion);

    // Burn the nonce FIRST. used_invites.nonce is the primary key, so two
    // concurrent redeems of the same invite cannot both enroll — the loser's
    // insert fails on the constraint and it is told the token was used.
    const seen = await ctx.db.get('SELECT 1 AS x FROM used_invites WHERE nonce = ?', [parsed.nonce]);
    if (seen) { res.status(400).json({ error: 'invite token already used' }); return; }
    try {
      await ctx.db.run('INSERT INTO used_invites (nonce, org_id) VALUES (?, ?)', [parsed.nonce, parsed.orgId]);
    } catch {
      res.status(400).json({ error: 'invite token already used' });
      return;
    }

    const childHubId = randomUUID();
    const now = new Date().toISOString();
    await ctx.db.run(
      'INSERT INTO child_hubs (id, org_id, name, hub_version, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
      [childHubId, parsed.orgId, name, hubVersion, now, now],
    );
    const token = await issueFederationKey(ctx.db, parsed.orgId, childHubId, `child-hub:${name}`);
    res.json({ token, childHubId, orgId: parsed.orgId, parentUrl: publicHubUrl(req) });
  });

  router.post('/ping', requireKey, async (req: Request, res: Response) => {
    const { childHubId, orgId } = req.hubFederation!;
    const hubVersion = semverOrNull(req.body?.hubVersion);
    await ctx.db.run(
      'UPDATE child_hubs SET last_seen = ?, hub_version = COALESCE(?, hub_version) WHERE id = ? AND org_id = ?',
      [new Date().toISOString(), hubVersion, childHubId, orgId],
    );
    res.json({ ok: true, childHubId, orgId });
  });

  // No directive kinds exist yet — flow dispatch (CGLAB-182) and upgrade
  // dispatch (CGLAB-183) add them. The route exists so a child worker built
  // now polls the final URL and simply sees "nothing to do".
  router.get('/directives', requireKey, (_req: Request, res: Response) => {
    res.status(204).end();
  });

  return router;
}
