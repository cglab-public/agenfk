import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireAdmin, signSession, setSessionCookie } from '../auth/session.js';

/**
 * Tables whose `org_id` column references `orgs.id` and must be repointed
 * when an admin renames the org. If you add a new table with an `org_id`
 * column, add it here. The companion regression test
 * (admin-org-rename.test.ts > schema covers all org_id-bearing tables) pins
 * this list against runtime introspection of sqlite_master + pragma_table_info
 * so the suite fails until this list is updated.
 */
export const ORG_ID_CHILD_TABLES: readonly string[] = [
  'api_keys',
  'auth_config',
  'device_codes',
  'events',
  'flow_assignments',
  'flows',
  'hidden_users',
  'installations',
  'model_mappings',
  'repoint_campaigns',
  'rollups_daily',
  'upgrade_directives',
  'used_invites',
  'user_key_aliases',
  'user_key_merges',
  'users',
];

const ORG_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function orgRenameRouter(ctx: HubServerContext): Router {
  const router = Router();
  const guard = requireAdmin(ctx.config.sessionSecret);

  // POST /v1/admin/orgs/rename
  router.post('/orgs/rename', guard, async (req: Request, res: Response) => {
    const session = req.session!;
    const from = typeof req.body?.from === 'string' ? req.body.from.trim() : '';
    const to   = typeof req.body?.to   === 'string' ? req.body.to.trim()   : '';

    if (!from || !to) {
      return res.status(400).json({ error: 'Body must be { from: string, to: string }.' });
    }
    if (from !== session.orgId) {
      return res.status(400).json({ error: '`from` must match the current org of the session.' });
    }
    if (from === to) {
      return res.status(400).json({ error: '`from` and `to` must differ.' });
    }
    if (!ORG_ID_REGEX.test(to)) {
      return res.status(400).json({ error: '`to` must match ^[a-z0-9][a-z0-9-]{1,62}$' });
    }
    const collision = await ctx.db.get<{ id: string }>('SELECT id FROM orgs WHERE id = ?', [to]);
    if (collision) {
      return res.status(409).json({ error: `Org id "${to}" already exists.` });
    }

    // Rewrite. orgs.id is the FK target, so insert the new row before
    // repointing children, and only delete the old row at the end.
    await ctx.db.transaction(async () => {
      // Carry over the human-readable name from the old row if any (else use `to`).
      const oldRow = await ctx.db.get<{ name: string }>('SELECT name FROM orgs WHERE id = ?', [from]);
      const carriedName = oldRow?.name ?? to;
      await ctx.db.run('INSERT INTO orgs (id, name) VALUES (?, ?)', [to, carriedName]);
      for (const tbl of ORG_ID_CHILD_TABLES) {
        await ctx.db.run(`UPDATE ${tbl} SET org_id = ? WHERE org_id = ?`, [to, from]);
      }
      await ctx.db.run('DELETE FROM orgs WHERE id = ?', [from]);
    });

    // Live process now serves the new org id. Without this, every auth
    // lookup in google.ts/entra.ts/auth.ts (which read ctx.config.defaultOrgId
    // directly) would query for a row that we just deleted.
    ctx.config.defaultOrgId = to;

    // Persist the env-update reminder so the UI banner survives page loads
    // and even subsequent admin sessions until someone acks it.
    await ctx.db.run(
      `INSERT INTO system_state (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['pending_env_orgid', to],
    );

    // Re-issue the caller's session cookie with the new orgId so subsequent
    // admin requests don't 401 against a deleted org. Strip the JWT-internal
    // claims (iat/exp) that verifySession leaves on the payload — passing
    // them back to jwt.sign with expiresIn would conflict.
    const { userId, role } = session;
    const newToken = signSession({ userId, role, orgId: to }, ctx.config.sessionSecret);
    setSessionCookie(res, newToken);

    res.json({
      ok: true,
      orgId: to,
      requiresEnvUpdate: true,
      envVar: 'AGENFK_HUB_ORG_ID',
    });
  });

  // GET /v1/admin/system/pending — drives the persistent banner.
  router.get('/system/pending', guard, async (_req: Request, res: Response) => {
    const row = await ctx.db.get<{ value: string }>(
      'SELECT value FROM system_state WHERE key = ?', ['pending_env_orgid'],
    );
    res.json({ pendingEnvOrgId: row?.value ?? null });
  });

  // POST /v1/admin/system/pending/ack — clears the banner once the operator
  // confirms they've updated the deployment manifest.
  router.post('/system/pending/ack', guard, async (_req: Request, res: Response) => {
    await ctx.db.run('DELETE FROM system_state WHERE key = ?', ['pending_env_orgid']);
    res.json({ ok: true });
  });

  return router;
}
