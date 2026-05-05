/**
 * Story 2 — Hub upgrade-directive API.
 *
 * Covers:
 *   POST /v1/admin/upgrade        — admin issues a directive (validates version, creates targets)
 *   GET  /v1/admin/upgrade        — admin lists directives with aggregate progress + per-installation rows
 *   GET  /v1/upgrade-directive    — fleet client polls for a pending directive (apiKey auth)
 *   POST /v1/events               — fleet:upgrade:* events transition directive_target state
 *
 * All cases run against the SQLite backend (the dual-backend pg-mem path is
 * exercised by hub-pg-parity for the routes it mirrors).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-upgrade-directives-${process.pid}.sqlite`);
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

async function seedInstallation(db: any, orgId: string, installationId: string, occurredAt = '2026-05-01T10:00:00Z') {
  await db.run(
    `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user)
     VALUES (?, ?, ?, ?, 'tester')`,
    [installationId, orgId, occurredAt, occurredAt],
  );
}

describe('Hub upgrade-directive API', () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;
  let cookieView: string;
  let fleetToken: string;

  beforeEach(async () => {
    cleanup();
    // Stub the GitHub-releases version-existence check so tests don't hit the network.
    // The route is expected to call a resolver named `releaseExists(version)` exposed
    // via the hub server context.
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a',
      releaseExists: async (version: string) => version === '0.3.1' || version === '0.3.0-beta.22',
    } as any);
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org-a', 'view@x', 'longenough1', 'viewer');
    cookieAdmin = await loginAs(app, 'admin@x', 'longenough1');
    cookieView = await loginAs(app, 'view@x', 'longenough1');

    await seedInstallation(ctx.db, 'org-a', 'inst-1');
    await seedInstallation(ctx.db, 'org-a', 'inst-2');
    fleetToken = await issueApiKey(ctx.db, 'org-a', 'inst-1-token', { installationId: 'inst-1' } as any);
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  describe('POST /v1/admin/upgrade', () => {
    it('rejects non-admin viewer with 403', async () => {
      const r = await supertest(app)
        .post('/v1/admin/upgrade')
        .set('Cookie', cookieView)
        .send({ targetVersion: '0.3.1', scope: { type: 'all' } });
      expect(r.status).toBe(403);
    });

    it('rejects malformed version with 400', async () => {
      const r = await supertest(app)
        .post('/v1/admin/upgrade')
        .set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.0.0; rm -rf /', scope: { type: 'all' } });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/semver|version/i);
    });

    it('rejects unknown released version with 422', async () => {
      const r = await supertest(app)
        .post('/v1/admin/upgrade')
        .set('Cookie', cookieAdmin)
        .send({ targetVersion: '9.9.9', scope: { type: 'all' } });
      expect(r.status).toBe(422);
    });

    it('creates a directive + pending targets for every installation in scope=all', async () => {
      const r = await supertest(app)
        .post('/v1/admin/upgrade')
        .set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.1', scope: { type: 'all' } });
      expect(r.status).toBe(201);
      expect(r.body.directiveId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.body.targetVersion).toBe('0.3.1');
      const targets = await ctx.db.all(
        'SELECT installation_id, state FROM upgrade_directive_targets WHERE directive_id = ?',
        [r.body.directiveId],
      );
      const ids = targets.map((t: any) => t.installation_id).sort();
      expect(ids).toEqual(['inst-1', 'inst-2']);
      expect(targets.every((t: any) => t.state === 'pending')).toBe(true);
    });

    it('creates a directive scoped to a single installation', async () => {
      const r = await supertest(app)
        .post('/v1/admin/upgrade')
        .set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.1', scope: { type: 'installation', installationId: 'inst-1' } });
      expect(r.status).toBe(201);
      const targets = await ctx.db.all(
        'SELECT installation_id FROM upgrade_directive_targets WHERE directive_id = ?',
        [r.body.directiveId],
      );
      expect(targets.map((t: any) => t.installation_id)).toEqual(['inst-1']);
    });
  });

  describe('GET /v1/admin/upgrade', () => {
    it('lists directives newest-first with aggregate progress counts', async () => {
      const create = await supertest(app)
        .post('/v1/admin/upgrade')
        .set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.1', scope: { type: 'all' } });
      const directiveId = create.body.directiveId;

      const r = await supertest(app).get('/v1/admin/upgrade').set('Cookie', cookieAdmin);
      expect(r.status).toBe(200);
      expect(r.body.directives).toHaveLength(1);
      const d = r.body.directives[0];
      expect(d.directiveId).toBe(directiveId);
      expect(d.targetVersion).toBe('0.3.1');
      expect(d.progress).toEqual({ pending: 2, in_progress: 0, succeeded: 0, failed: 0 });
      expect(d.targets.map((t: any) => t.installationId).sort()).toEqual(['inst-1', 'inst-2']);
    });
  });

  describe('GET /v1/upgrade-directive (fleet poll)', () => {
    it('returns 204 when no directive is pending for the calling installation', async () => {
      const r = await supertest(app)
        .get('/v1/upgrade-directive')
        .set('Authorization', `Bearer ${fleetToken}`);
      expect(r.status).toBe(204);
    });

    it('returns the pending directive for the calling installation only', async () => {
      const create = await supertest(app)
        .post('/v1/admin/upgrade')
        .set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.1', scope: { type: 'installation', installationId: 'inst-1' } });
      const directiveId = create.body.directiveId;

      const r = await supertest(app)
        .get('/v1/upgrade-directive')
        .set('Authorization', `Bearer ${fleetToken}`);
      expect(r.status).toBe(200);
      expect(r.body.directiveId).toBe(directiveId);
      expect(r.body.targetVersion).toBe('0.3.1');
    });

    it('does not return a directive scoped to a different installation', async () => {
      await supertest(app)
        .post('/v1/admin/upgrade')
        .set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.1', scope: { type: 'installation', installationId: 'inst-2' } });
      const r = await supertest(app)
        .get('/v1/upgrade-directive')
        .set('Authorization', `Bearer ${fleetToken}`);
      expect(r.status).toBe(204);
    });

    it('rejects unauthenticated requests with 401', async () => {
      const r = await supertest(app).get('/v1/upgrade-directive');
      expect(r.status).toBe(401);
    });
  });

  describe('Event ingest — fleet:upgrade:* transitions directive_target state', () => {
    async function issueDirective(): Promise<string> {
      const create = await supertest(app)
        .post('/v1/admin/upgrade')
        .set('Cookie', cookieAdmin)
        .send({ targetVersion: '0.3.1', scope: { type: 'installation', installationId: 'inst-1' } });
      return create.body.directiveId;
    }

    const sendEvent = (directiveId: string, type: string, extra: Record<string, any> = {}) =>
      supertest(app)
        .post('/v1/events')
        .set('Authorization', `Bearer ${fleetToken}`)
        .send({
          events: [{
            eventId: `evt-${type}-${Math.random().toString(36).slice(2)}`,
            installationId: 'inst-1',
            orgId: 'org-a',
            occurredAt: new Date().toISOString(),
            actor: { osUser: 'tester' },
            type,
            payload: { directiveId, ...extra },
          }],
        });

    it('fleet:upgrade:started sets state=in_progress', async () => {
      const directiveId = await issueDirective();
      const r = await sendEvent(directiveId, 'fleet:upgrade:started');
      expect(r.status).toBe(200);
      const target = await ctx.db.get(
        'SELECT state FROM upgrade_directive_targets WHERE directive_id = ? AND installation_id = ?',
        [directiveId, 'inst-1'],
      );
      expect(target.state).toBe('in_progress');
    });

    it('fleet:upgrade:succeeded sets state=succeeded + result_version', async () => {
      const directiveId = await issueDirective();
      await sendEvent(directiveId, 'fleet:upgrade:started');
      const r = await sendEvent(directiveId, 'fleet:upgrade:succeeded', { resultVersion: '0.3.1' });
      expect(r.status).toBe(200);
      const target = await ctx.db.get(
        'SELECT state, result_version FROM upgrade_directive_targets WHERE directive_id = ? AND installation_id = ?',
        [directiveId, 'inst-1'],
      );
      expect(target.state).toBe('succeeded');
      expect(target.result_version).toBe('0.3.1');
    });

    it('fleet:upgrade:failed sets state=failed + error_message', async () => {
      const directiveId = await issueDirective();
      const r = await sendEvent(directiveId, 'fleet:upgrade:failed', { error: 'install.mjs exit 1' });
      expect(r.status).toBe(200);
      const target = await ctx.db.get(
        'SELECT state, error_message FROM upgrade_directive_targets WHERE directive_id = ? AND installation_id = ?',
        [directiveId, 'inst-1'],
      );
      expect(target.state).toBe('failed');
      expect(target.error_message).toMatch(/install\.mjs exit 1/);
    });
  });
});
