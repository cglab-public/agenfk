// Tests for CGLAB-31 fleet exclusions: hidden people disappear from the
// admin installations list (unless explicitly requested) and from upgrade
// targeting (scope=all skips them; explicitly naming one is rejected).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-fleet-hidden-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const loginAs = async (app: any, email: string, password: string) => {
  const r = await supertest(app).post('/auth/login').send({ email, password });
  return r.headers['set-cookie']?.[0] ?? '';
};

async function seedInstallation(db: any, orgId: string, id: string, gitEmail: string | null, version = '0.3.0') {
  await db.run(
    `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email, agenfk_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, orgId, '2026-05-01T00:00:00Z', '2026-05-06T00:00:00Z', 'user', null, gitEmail, version],
  );
}

const hide = (db: any, orgId: string, userKey: string) =>
  db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', [orgId, userKey]);

describe('fleet exclusions for hidden people (CGLAB-31)', () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a',
      releaseExists: async (v: string) => v === '0.4.0',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    cookieAdmin = await loginAs(app, 'admin@x', 'longenough1');
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  describe('GET /v1/admin/installations', () => {
    it('excludes installations of hidden people by default', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-visible', 'active@acme.com');
      await seedInstallation(ctx.db, 'org-a', 'inst-hidden', 'departed@acme.com');
      await hide(ctx.db, 'org-a', 'departed@acme.com');

      const r = await supertest(app).get('/v1/admin/installations').set('Cookie', cookieAdmin);
      expect(r.status).toBe(200);
      expect(r.body.map((i: any) => i.id)).toEqual(['inst-visible']);
    });

    it('matches hidden people case-insensitively on git email', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-hidden', 'Departed@Acme.COM');
      await hide(ctx.db, 'org-a', 'departed@acme.com');

      const r = await supertest(app).get('/v1/admin/installations').set('Cookie', cookieAdmin);
      expect(r.body.map((i: any) => i.id)).toEqual([]);
    });

    it('?includeHidden=1 returns hidden installations flagged with hidden:true', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-visible', 'active@acme.com');
      await seedInstallation(ctx.db, 'org-a', 'inst-hidden', 'departed@acme.com');
      await hide(ctx.db, 'org-a', 'departed@acme.com');

      const r = await supertest(app).get('/v1/admin/installations?includeHidden=1').set('Cookie', cookieAdmin);
      expect(r.status).toBe(200);
      expect(r.body).toHaveLength(2);
      const byId = Object.fromEntries(r.body.map((i: any) => [i.id, i]));
      expect(byId['inst-visible'].hidden ?? false).toBe(false);
      expect(byId['inst-hidden'].hidden).toBe(true);
    });

    it('unhide restores the installation to the default list', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-hidden', 'departed@acme.com');
      await hide(ctx.db, 'org-a', 'departed@acme.com');
      await ctx.db.run('DELETE FROM hidden_users WHERE org_id = ? AND user_key = ?', ['org-a', 'departed@acme.com']);

      const r = await supertest(app).get('/v1/admin/installations').set('Cookie', cookieAdmin);
      expect(r.body.map((i: any) => i.id)).toEqual(['inst-hidden']);
    });
  });

  describe('POST /v1/admin/upgrade — targeting', () => {
    it('scope=all skips hidden people\'s installations', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-visible', 'active@acme.com');
      await seedInstallation(ctx.db, 'org-a', 'inst-hidden', 'departed@acme.com');
      await hide(ctx.db, 'org-a', 'departed@acme.com');

      const r = await supertest(app).post('/v1/admin/upgrade')
        .set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.4.0', scope: { type: 'all' } });
      expect(r.status).toBe(201);

      const targets = await ctx.db.all<{ installation_id: string }>(
        'SELECT installation_id FROM upgrade_directive_targets',
      );
      expect(targets.map(t => t.installation_id)).toEqual(['inst-visible']);
    });

    it('scope=installation naming a hidden person\'s install is rejected (409)', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-hidden', 'departed@acme.com');
      await hide(ctx.db, 'org-a', 'departed@acme.com');

      const r = await supertest(app).post('/v1/admin/upgrade')
        .set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.4.0', scope: { type: 'installation', installationId: 'inst-hidden' } });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/hidden/i);

      const directives = await ctx.db.all('SELECT id FROM upgrade_directives');
      expect(directives).toHaveLength(0);
    });

    it('scope=installations including a hidden person\'s install is rejected (409)', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-visible', 'active@acme.com');
      await seedInstallation(ctx.db, 'org-a', 'inst-hidden', 'departed@acme.com');
      await hide(ctx.db, 'org-a', 'departed@acme.com');

      const r = await supertest(app).post('/v1/admin/upgrade')
        .set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.4.0', scope: { type: 'installations', installationIds: ['inst-visible', 'inst-hidden'] } });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/hidden/i);

      const directives = await ctx.db.all('SELECT id FROM upgrade_directives');
      expect(directives).toHaveLength(0);
    });

    it('scope=installation on a visible install still works', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-visible', 'active@acme.com');

      const r = await supertest(app).post('/v1/admin/upgrade')
        .set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.4.0', scope: { type: 'installation', installationId: 'inst-visible' } });
      expect(r.status).toBe(201);
    });
  });
});
