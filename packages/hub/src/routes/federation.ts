import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes, randomUUID } from 'crypto';
import { HubServerContext } from '../server.js';
import { requireAdmin } from '../auth/session.js';
import { signInviteToken, verifyInviteToken, burnInviteNonce, INVITE_TTL_MS } from '../auth/inviteToken.js';
import { semverOrNull } from '../util/semver.js';
import { issueFederationKey, requireFederationKey } from '../auth/federationKey.js';
import { publicHubUrl } from '../util/publicUrl.js';
import { rateLimit } from '../util/rateLimit.js';
import { MAX_CHILD_HUB_NAME_LEN, validChildHubName } from '../util/childHubRow.js';

// Hub federation, parent side (CGLAB-181). A child hub enrolls by redeeming an
// admin-issued invite of kind 'child-hub', then heartbeats and polls for
// directives with the federation key it received. Two routers are exported
// because the enrollment invite lives under the session-guarded /hub prefix
// (next to the installation invite) while the child-facing API lives under
// /v1 like every other machine-to-machine route.

// An invite is ~200 chars. Cap the input before it reaches createHmac so an
// unauthenticated caller cannot make the hub HMAC megabytes per request.
const MAX_INVITE_TOKEN_LEN = 4096;

/** Admin-facing: mint a child-hub invite. Mounted under /hub/federation. */
export function federationInviteRouter(ctx: HubServerContext): Router {
  const router = Router();
  const adminGuard = requireAdmin(ctx.config.sessionSecret);

  router.post('/invite/create', adminGuard, (req: Request, res: Response) => {
    res.json(mintChildHubInvite(req.session!.orgId, ctx.config.secretKey, publicHubUrl(req)));
  });

  return router;
}

/** Mint a child-hub invite. Shared by the /hub route and the admin tab's button. */
export function mintChildHubInvite(orgId: string, secretKey: string, parentUrl: string) {
  const nonce = randomBytes(18).toString('base64url');
  const exp = Date.now() + INVITE_TTL_MS;
  return {
    inviteToken: signInviteToken({ orgId, nonce, exp, kind: 'child-hub' }, secretKey),
    parentUrl,
    expiresAt: new Date(exp).toISOString(),
  };
}

/** Child-facing: enroll, heartbeat, poll directives. Mounted under /v1/federation. */
export function federationRouter(ctx: HubServerContext): Router {
  const router = Router();
  const requireKey = requireFederationKey(ctx.db);

  // /enroll is the one unauthenticated federation route, so it carries its own
  // limiter rather than relying on one an unrelated router happens to apply at
  // the shared /v1 mount. Same budget as /hub/device/start.
  const enrollRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, max: 60,
    message: 'Too many enrollment attempts, slow down.',
  });

  router.post('/enroll', enrollRateLimit, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inviteToken = String(req.body?.inviteToken ?? '');
      if (!inviteToken) { res.status(400).json({ error: 'inviteToken required' }); return; }
      if (inviteToken.length > MAX_INVITE_TOKEN_LEN) { res.status(400).json({ error: 'invalid invite token' }); return; }
      const parsed = verifyInviteToken(inviteToken, ctx.config.secretKey, 'child-hub');
      if (!parsed) { res.status(400).json({ error: 'invalid invite token' }); return; }
      if (parsed.exp < Date.now()) { res.status(400).json({ error: 'invite token expired' }); return; }

      const rawName = req.body?.childHub?.name;
      const name = validChildHubName(rawName);
      if (!name) {
        const tooLong = typeof rawName === 'string' && rawName.trim().length > MAX_CHILD_HUB_NAME_LEN;
        res.status(400).json({
          error: tooLong ? `childHub.name exceeds ${MAX_CHILD_HUB_NAME_LEN} characters` : 'childHub.name required',
        });
        return;
      }
      const hubVersion = semverOrNull(req.body?.childHub?.hubVersion);

      const childHubId = randomUUID();
      const now = new Date().toISOString();

      // One transaction for all three writes. Burning the nonce first makes the
      // PRIMARY KEY the concurrency control, and rolling back together means a
      // failure part-way leaves neither an orphan child_hubs row nor a spent
      // invite — the admin's invite stays usable.
      const outcome = await ctx.db.transaction(async () => {
        if (!await burnInviteNonce(ctx.db, parsed.nonce, parsed.orgId)) return null;
        await ctx.db.run(
          'INSERT INTO child_hubs (id, org_id, name, hub_version, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
          [childHubId, parsed.orgId, name, hubVersion, now, now],
        );
        return issueFederationKey(ctx.db, parsed.orgId, childHubId, `child-hub:${name}`);
      });
      if (!outcome) { res.status(400).json({ error: 'invite token already used' }); return; }

      res.json({ token: outcome, childHubId, orgId: parsed.orgId, parentUrl: publicHubUrl(req) });
    } catch (err) {
      // express 4 does not forward a rejected promise, so without this the
      // child would hang until timeout instead of seeing a 500.
      next(err);
    }
  });

  router.post('/ping', requireKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { childHubId, orgId } = req.hubFederation!;
      const hubVersion = semverOrNull(req.body?.hubVersion);
      await ctx.db.run(
        'UPDATE child_hubs SET last_seen = ?, hub_version = COALESCE(?, hub_version) WHERE id = ? AND org_id = ?',
        [new Date().toISOString(), hubVersion, childHubId, orgId],
      );
      res.json({ ok: true, childHubId, orgId });
    } catch (err) {
      next(err);
    }
  });

  /**
   * A child asking to be let go. Recording it is all this does: the parent's
   * existing detach is the approval, so there is no approve verb and no second
   * state machine to drift out of step with detached_at.
   */
  router.post('/release-request', requireKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { childHubId, orgId } = req.hubFederation!;
      const raw = req.body?.reason;
      const reason = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 500) : null;
      // COALESCE keeps the ORIGINAL timestamp: an impatient child re-asking
      // must not jump the queue an admin is working through. The reason is
      // COALESCEd the other way round — a NEW reason replaces, but re-asking
      // with none must not erase the sentence the admin was reading.
      await ctx.db.run(
        `UPDATE child_hubs
            SET release_requested_at = COALESCE(release_requested_at, ?),
                release_reason = COALESCE(?, release_reason)
          WHERE id = ? AND org_id = ?`,
        [new Date().toISOString(), reason, childHubId, orgId],
      );
      res.json({ ok: true, childHubId });
    } catch (err) { next(err); }
  });

  // No directive kinds exist yet — flow dispatch (CGLAB-182) and upgrade
  // dispatch (CGLAB-183) add them. The route exists so a child worker built
  // now polls the final URL and simply sees "nothing to do".
  router.get('/directives', requireKey, (_req: Request, res: Response) => {
    res.status(204).end();
  });

  return router;
}
