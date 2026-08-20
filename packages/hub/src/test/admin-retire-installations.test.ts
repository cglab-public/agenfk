// Tests for the retire-installation admin API (CGLAB-64):
//   POST   /v1/admin/installations/:id/retire  — retire (revoke keys + cancel directives)
//   DELETE /v1/admin/installations/:id/retire  — unretire (flag only)
//   GET    /v1/admin/installations             — excludes retired unless ?includeRetired=1
//
// Retiring exists so a dead installation (retired laptop, departed dev) stops
// blocking fleet accounting: without cancelling its pending upgrade-directive
// targets, a repoint or upgrade campaign board hangs on it forever.
//
// Historical data is deliberately untouched — events are attributed by
// user_key, not installation_id, so a retired install's history keeps counting
// for the person.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-retire-${process.pid}.sqlite`);
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

async function seedInstallation(db: any, orgId: string, id: string, gitEmail: string | null) {
  await db.run(
    `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, orgId, '2026-05-01T00:00:00Z', '2026-05-06T00:00:00Z', 'user', null, gitEmail],
  );
}

async function seedApiKey(db: any, orgId: string, tokenHash: string, installationId: string | null) {
  await db.run(
    `INSERT INTO api_keys (token_hash, org_id, label, installation_id) VALUES (?, ?, ?, ?)`,
    [tokenHash, orgId, 'test-key', installationId],
  );
}

async function seedDirective(db: any, orgId: string, directiveId: string, installationId: string, state = 'pending') {
  await db.run(
    `INSERT INTO upgrade_directives (id, org_id, target_version, scope_type, scope_id)
     VALUES (?, ?, ?, ?, ?)`,
    [directiveId, orgId, '1.2.3', 'installation', installationId],
  );
  await db.run(
    `INSERT INTO upgrade_directive_targets (directive_id, installation_id, state) VALUES (?, ?, ?)`,
    [directiveId, installationId, state],
  );
}

const liveKeys = (db: any, orgId: string, installationId: string) =>
  db.get(
    'SELECT COUNT(*) AS n FROM api_keys WHERE org_id = ? AND installation_id = ? AND revoked_at IS NULL',
    [orgId, installationId],
  );

const targetState = (db: any, directiveId: string, installationId: string) =>
  db.get(
    'SELECT state FROM upgrade_directive_targets WHERE directive_id = ? AND installation_id = ?',
    [directiveId, installationId],
  );

describe('retire-installation admin API', () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;
  let cookieView: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org-a', 'view@x', 'longenough1', 'viewer');
    cookieAdmin = await loginAs(app, 'admin@x', 'longenough1');
    cookieView = await loginAs(app, 'view@x', 'longenough1');
    await seedInstallation(ctx.db, 'org-a', 'inst-1', 'dev@acme.com');
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  describe('authz', () => {
    it('rejects unauthenticated requests', async () => {
      expect((await supertest(app).post('/v1/admin/installations/inst-1/retire')).status).toBe(401);
      expect((await supertest(app).delete('/v1/admin/installations/inst-1/retire')).status).toBe(401);
    });

    it('rejects non-admin sessions', async () => {
      expect((await supertest(app).post('/v1/admin/installations/inst-1/retire').set('Cookie', cookieView)).status).toBe(403);
      expect((await supertest(app).delete('/v1/admin/installations/inst-1/retire').set('Cookie', cookieView)).status).toBe(403);
    });
  });

  describe('POST retire', () => {
    it('retires the installation and records who did it', async () => {
      const r = await supertest(app).post('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);
      expect(r.status).toBe(200);
      expect(r.body.id).toBe('inst-1');
      expect(r.body.retiredAt).toBeTruthy();

      const list = await supertest(app)
        .get('/v1/admin/installations?includeRetired=1')
        .set('Cookie', cookieAdmin);
      const row = list.body.find((i: any) => i.id === 'inst-1');
      expect(row.retired).toBe(true);
      expect(row.retiredByEmail).toBe('admin@x');
    });

    it('revokes every live api_key bound to the installation', async () => {
      await seedApiKey(ctx.db, 'org-a', 'hash-a', 'inst-1');
      await seedApiKey(ctx.db, 'org-a', 'hash-b', 'inst-1');

      const r = await supertest(app).post('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);

      expect(r.body.revokedApiKeys).toBe(2);
      expect(Number((await liveKeys(ctx.db, 'org-a', 'inst-1')).n)).toBe(0);
    });

    it('leaves other installations api_keys alone', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-2', 'other@acme.com');
      await seedApiKey(ctx.db, 'org-a', 'hash-a', 'inst-1');
      await seedApiKey(ctx.db, 'org-a', 'hash-other', 'inst-2');

      await supertest(app).post('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);

      expect(Number((await liveKeys(ctx.db, 'org-a', 'inst-2')).n)).toBe(1);
    });

    it('cancels pending upgrade-directive targets so campaign boards can drain', async () => {
      await seedDirective(ctx.db, 'org-a', 'dir-1', 'inst-1', 'pending');

      const r = await supertest(app).post('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);

      expect(r.body.cancelledDirectiveTargets).toBe(1);
      expect((await targetState(ctx.db, 'dir-1', 'inst-1')).state).toBe('cancelled');
    });

    it('does not rewrite already-finished directive targets', async () => {
      await seedDirective(ctx.db, 'org-a', 'dir-done', 'inst-1', 'succeeded');

      const r = await supertest(app).post('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);

      expect(r.body.cancelledDirectiveTargets).toBe(0);
      expect((await targetState(ctx.db, 'dir-done', 'inst-1')).state).toBe('succeeded');
    });

    it('leaves events and rollups untouched', async () => {
      await ctx.db.run(
        `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['ev-1', 'org-a', 'inst-1', 'dev@acme.com', '2026-05-02T00:00:00Z', '2026-05-02T00:00:00Z', 'item.created', '{}'],
      );
      await ctx.db.run(
        `INSERT INTO rollups_daily (org_id, user_key, day, events_count) VALUES (?, ?, ?, ?)`,
        ['org-a', 'dev@acme.com', '2026-05-02', 1],
      );

      await supertest(app).post('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);

      const ev = await ctx.db.get('SELECT installation_id, user_key FROM events WHERE event_id = ?', ['ev-1']);
      expect(ev.installation_id).toBe('inst-1'); // provenance is immutable
      expect(ev.user_key).toBe('dev@acme.com');
      const roll = await ctx.db.get(
        'SELECT events_count FROM rollups_daily WHERE org_id = ? AND user_key = ? AND day = ?',
        ['org-a', 'dev@acme.com', '2026-05-02'],
      );
      expect(Number(roll.events_count)).toBe(1);
    });

    it('is idempotent — retiring twice is not an error and does not double-count', async () => {
      await seedApiKey(ctx.db, 'org-a', 'hash-a', 'inst-1');
      const first = await supertest(app).post('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);
      const second = await supertest(app).post('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.revokedApiKeys).toBe(0); // already revoked by the first call
      expect(second.body.retiredAt).toBe(first.body.retiredAt); // original timestamp preserved
    });

    it('404s an unknown installation', async () => {
      const r = await supertest(app).post('/v1/admin/installations/nope/retire').set('Cookie', cookieAdmin);
      expect(r.status).toBe(404);
    });

    it('404s an installation belonging to another org', async () => {
      await ctx.db.run("INSERT INTO orgs (id, name) VALUES ('org-b', 'B')");
      await seedInstallation(ctx.db, 'org-b', 'inst-b', 'x@b.com');

      const r = await supertest(app).post('/v1/admin/installations/inst-b/retire').set('Cookie', cookieAdmin);

      expect(r.status).toBe(404);
      const row = await ctx.db.get('SELECT retired_at FROM installations WHERE id = ?', ['inst-b']);
      expect(row.retired_at).toBeFalsy(); // untouched across the org boundary
    });
  });

  describe('DELETE retire (unretire)', () => {
    it('clears the retired flag', async () => {
      await supertest(app).post('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);

      const r = await supertest(app).delete('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);
      expect(r.status).toBe(200);
      expect(r.body.retired).toBe(false);

      const list = await supertest(app).get('/v1/admin/installations').set('Cookie', cookieAdmin);
      expect(list.body.some((i: any) => i.id === 'inst-1')).toBe(true);
    });

    it('does NOT restore revoked api_keys — the person re-joins', async () => {
      await seedApiKey(ctx.db, 'org-a', 'hash-a', 'inst-1');
      await supertest(app).post('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);

      await supertest(app).delete('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);

      expect(Number((await liveKeys(ctx.db, 'org-a', 'inst-1')).n)).toBe(0);
    });

    it('404s an unknown installation', async () => {
      const r = await supertest(app).delete('/v1/admin/installations/nope/retire').set('Cookie', cookieAdmin);
      expect(r.status).toBe(404);
    });
  });

  describe('GET /v1/admin/installations filtering', () => {
    it('excludes retired installations by default', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-2', 'other@acme.com');
      await supertest(app).post('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);

      const list = await supertest(app).get('/v1/admin/installations').set('Cookie', cookieAdmin);

      expect(list.body.map((i: any) => i.id)).toEqual(['inst-2']);
    });

    it('includes them flagged when asked', async () => {
      await supertest(app).post('/v1/admin/installations/inst-1/retire').set('Cookie', cookieAdmin);

      const list = await supertest(app).get('/v1/admin/installations?includeRetired=1').set('Cookie', cookieAdmin);

      const row = list.body.find((i: any) => i.id === 'inst-1');
      expect(row).toBeTruthy();
      expect(row.retired).toBe(true);
    });

    it('reports retired:false for live installations', async () => {
      const list = await supertest(app).get('/v1/admin/installations').set('Cookie', cookieAdmin);
      expect(list.body.find((i: any) => i.id === 'inst-1').retired).toBe(false);
    });
  });
});
