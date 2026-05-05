/**
 * Story 5 — hardening pass on POST /v1/admin/upgrade.
 *
 * Three guards layered onto the existing happy-path:
 *   - audit metadata: createdByEmail + requestIp persisted on the directive.
 *   - downgrade confirmation: 409 when ANY in-scope installation would move
 *     to an older version unless the caller passed confirmDowngrade=true.
 *   - single-pending guard: 409 when ANY in-scope installation already has a
 *     pending or in_progress target on a prior directive.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-upgrade-hardening-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

async function seedInstallation(db: any, orgId: string, id: string, agenfkVersion: string | null = null) {
  await db.run(
    `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, agenfk_version, agenfk_version_updated_at)
     VALUES (?, ?, '2026-05-01T10:00:00Z', '2026-05-01T10:00:00Z', 'tester', ?, ?)`,
    [id, orgId, agenfkVersion, agenfkVersion ? '2026-05-01T10:00:00Z' : null],
  );
}

describe('Story 5 — POST /v1/admin/upgrade hardening', () => {
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
      releaseExists: async () => true,
    } as any);
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookieAdmin = login.headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  describe('audit metadata', () => {
    it('persists created_by_email + request_ip and surfaces them in GET /v1/admin/upgrade', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-1');
      await supertest(app)
        .post('/v1/admin/upgrade').set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.1', scope: { type: 'all' } });
      const r = await supertest(app).get('/v1/admin/upgrade').set('Cookie', cookieAdmin);
      expect(r.status).toBe(200);
      const d = r.body.directives[0];
      expect(d.createdByEmail).toBe('admin@x');
      // requestIp is whatever supertest's loopback resolves to — assert it's a non-empty string.
      expect(typeof d.requestIp).toBe('string');
      expect(d.requestIp.length).toBeGreaterThan(0);
    });
  });

  describe('downgrade confirmation', () => {
    it('returns 409 with downgrades[] when any in-scope installation would move to an older version', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-1', '0.3.5');
      await seedInstallation(ctx.db, 'org-a', 'inst-2', '0.3.0');
      const r = await supertest(app)
        .post('/v1/admin/upgrade').set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.1', scope: { type: 'all' } });
      expect(r.status).toBe(409);
      expect(r.body.downgrades).toBeDefined();
      const downgraded = r.body.downgrades.map((d: any) => d.installationId);
      expect(downgraded).toContain('inst-1');
      expect(downgraded).not.toContain('inst-2');
      expect(r.body.downgrades[0].currentVersion).toBe('0.3.5');
      expect(r.body.downgrades[0].targetVersion).toBe('0.3.1');
    });

    it('proceeds when confirmDowngrade=true is passed', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-1', '0.3.5');
      const r = await supertest(app)
        .post('/v1/admin/upgrade').set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.1', scope: { type: 'all' }, confirmDowngrade: true });
      expect(r.status).toBe(201);
    });

    it('proceeds without confirmation when no installation is being downgraded', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-1', '0.3.0');
      const r = await supertest(app)
        .post('/v1/admin/upgrade').set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.1', scope: { type: 'all' } });
      expect(r.status).toBe(201);
    });

    it('proceeds without confirmation when an installation has no known version yet', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-fresh', null);
      const r = await supertest(app)
        .post('/v1/admin/upgrade').set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.1', scope: { type: 'all' } });
      expect(r.status).toBe(201);
    });
  });

  describe('single-pending guard', () => {
    it('returns 409 with conflicts[] when any in-scope installation has a pending target', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-1', '0.3.0');
      const first = await supertest(app)
        .post('/v1/admin/upgrade').set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.1', scope: { type: 'all' } });
      expect(first.status).toBe(201);

      const second = await supertest(app)
        .post('/v1/admin/upgrade').set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.2', scope: { type: 'all' } });
      expect(second.status).toBe(409);
      expect(second.body.conflicts).toBeDefined();
      expect(second.body.conflicts[0].installationId).toBe('inst-1');
      expect(second.body.conflicts[0].conflictingDirectiveId).toBe(first.body.directiveId);
    });

    it('does not block when the prior directive has already finished (succeeded/failed only)', async () => {
      await seedInstallation(ctx.db, 'org-a', 'inst-1', '0.3.0');
      const first = await supertest(app)
        .post('/v1/admin/upgrade').set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.1', scope: { type: 'all' } });
      // Simulate the fleet client reporting succeeded — directly transition the row.
      await ctx.db.run(
        "UPDATE upgrade_directive_targets SET state = 'succeeded' WHERE directive_id = ?",
        [first.body.directiveId],
      );
      const second = await supertest(app)
        .post('/v1/admin/upgrade').set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.2', scope: { type: 'all' } });
      expect(second.status).toBe(201);
    });
  });
});
