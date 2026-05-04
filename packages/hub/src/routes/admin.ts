import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireAdmin } from '../auth/session.js';
import { issueApiKey } from '../auth/apiKey.js';
import { encryptSecret } from '../crypto.js';
import { createPasswordUser, hashPassword } from '../auth/password.js';

interface AuthConfigRow {
  org_id: string;
  password_enabled: number;
  google_enabled: number;
  google_client_id: string | null;
  google_client_secret_enc: string | null;
  entra_enabled: number;
  entra_tenant_id: string | null;
  entra_client_id: string | null;
  entra_client_secret_enc: string | null;
  email_allowlist: string | null;
}

function publicAuthConfig(row: AuthConfigRow) {
  return {
    passwordEnabled: !!row.password_enabled,
    googleEnabled: !!row.google_enabled,
    google: { clientId: row.google_client_id ?? '', clientSecretSet: !!row.google_client_secret_enc },
    entraEnabled: !!row.entra_enabled,
    entra: {
      tenantId: row.entra_tenant_id ?? '',
      clientId: row.entra_client_id ?? '',
      clientSecretSet: !!row.entra_client_secret_enc,
    },
    emailAllowlist: row.email_allowlist ? JSON.parse(row.email_allowlist) : [],
  };
}

export function adminRouter(ctx: HubServerContext): Router {
  const router = Router();
  const guard = requireAdmin(ctx.config.sessionSecret);

  // ── Auth config ──────────────────────────────────────────────────────────
  router.get('/auth-config', guard, async (req: Request, res: Response) => {
    const row = await ctx.db.get<AuthConfigRow>('SELECT * FROM auth_config WHERE org_id = ?', [req.session!.orgId]);
    if (!row) return res.status(404).json({ error: 'auth_config row missing for org' });
    res.json(publicAuthConfig(row));
  });

  router.put('/auth-config', guard, async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const b = req.body ?? {};
    const updates: string[] = [];
    const params: any[] = [];
    const setField = (col: string, val: any) => { updates.push(`${col} = ?`); params.push(val); };

    if (b.passwordEnabled !== undefined) setField('password_enabled', b.passwordEnabled ? 1 : 0);
    if (b.googleEnabled !== undefined) setField('google_enabled', b.googleEnabled ? 1 : 0);
    if (b.google?.clientId !== undefined) setField('google_client_id', b.google.clientId || null);
    if (typeof b.google?.clientSecret === 'string' && b.google.clientSecret) {
      setField('google_client_secret_enc', encryptSecret(b.google.clientSecret, ctx.config.secretKey));
    }
    if (b.entraEnabled !== undefined) setField('entra_enabled', b.entraEnabled ? 1 : 0);
    if (b.entra?.tenantId !== undefined) setField('entra_tenant_id', b.entra.tenantId || null);
    if (b.entra?.clientId !== undefined) setField('entra_client_id', b.entra.clientId || null);
    if (typeof b.entra?.clientSecret === 'string' && b.entra.clientSecret) {
      setField('entra_client_secret_enc', encryptSecret(b.entra.clientSecret, ctx.config.secretKey));
    }
    if (Array.isArray(b.emailAllowlist)) setField('email_allowlist', JSON.stringify(b.emailAllowlist));

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(orgId);
    await ctx.db.run(`UPDATE auth_config SET ${updates.join(', ')} WHERE org_id = ?`, params);
    const row = await ctx.db.get<AuthConfigRow>('SELECT * FROM auth_config WHERE org_id = ?', [orgId]);
    if (!row) return res.status(404).json({ error: 'auth_config row missing for org' });
    res.json(publicAuthConfig(row));
  });

  // ── API keys (installation tokens) ───────────────────────────────────────
  router.get('/api-keys', guard, async (req: Request, res: Response) => {
    const rows = await ctx.db.all<any>(
      'SELECT token_hash, label, created_at, revoked_at FROM api_keys WHERE org_id = ? ORDER BY created_at DESC',
      [req.session!.orgId],
    );
    res.json(rows.map(r => ({
      tokenHashPreview: r.token_hash.slice(0, 8),
      label: r.label,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
    })));
  });

  router.post('/api-keys', guard, async (req: Request, res: Response) => {
    const label = typeof req.body?.label === 'string' ? req.body.label : null;
    const token = await issueApiKey(ctx.db, req.session!.orgId, label ?? undefined);
    res.status(201).json({ token, label });
  });

  router.delete('/api-keys/:tokenHashPreview', guard, async (req: Request, res: Response) => {
    const preview = req.params.tokenHashPreview;
    const result = await ctx.db.run(
      "UPDATE api_keys SET revoked_at = datetime('now') WHERE org_id = ? AND token_hash LIKE ? AND revoked_at IS NULL",
      [req.session!.orgId, `${preview}%`],
    );
    res.json({ revoked: result.changes });
  });

  // ── Users ────────────────────────────────────────────────────────────────
  router.get('/users', guard, async (req: Request, res: Response) => {
    const rows = await ctx.db.all(
      'SELECT id, email, provider, role, active, created_at, last_login_at FROM users WHERE org_id = ? ORDER BY created_at DESC',
      [req.session!.orgId],
    );
    res.json(rows);
  });

  router.post('/users/invite', guard, async (req: Request, res: Response) => {
    const { email, password, role } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'email + password (≥8 chars) required' });
    }
    if (role !== 'admin' && role !== 'viewer') return res.status(400).json({ error: 'role must be admin or viewer' });
    try {
      const u = await createPasswordUser(ctx.db, req.session!.orgId, email, password, role);
      res.status(201).json({ id: u.id, email: u.email, role: u.role });
    } catch (e: any) {
      res.status(409).json({ error: 'A user with that email already exists' });
    }
  });

  router.put('/users/:id', guard, async (req: Request, res: Response) => {
    const { role, active, password } = req.body ?? {};
    const sets: string[] = [];
    const params: any[] = [];
    if (role === 'admin' || role === 'viewer') { sets.push('role = ?'); params.push(role); }
    if (active === true || active === false) { sets.push('active = ?'); params.push(active ? 1 : 0); }
    if (typeof password === 'string' && password.length >= 8) { sets.push('password_hash = ?'); params.push(hashPassword(password)); }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.params.id, req.session!.orgId);
    const result = await ctx.db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`, params);
    if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  });

  router.delete('/users/:id', guard, async (req: Request, res: Response) => {
    if (req.session!.userId === req.params.id) return res.status(400).json({ error: 'Cannot delete the signed-in user' });
    const result = await ctx.db.run('DELETE FROM users WHERE id = ? AND org_id = ?', [req.params.id, req.session!.orgId]);
    if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  });

  return router;
}
