/**
 * Hub admin: cancel a pending fleet upgrade directive.
 *
 * Covers POST /v1/admin/upgrade/:directiveId/cancel — flips every target
 * still in state='pending' to 'cancelled', leaves in_progress/succeeded/failed
 * alone, and is idempotent. Cancelled targets:
 *   - drop off the fleet poll (GET /v1/upgrade-directive returns 204)
 *   - no longer block a fresh directive (single-pending guard treats them as terminal)
 *   - surface in GET /v1/admin/upgrade as `progress.cancelled`
 *
 * Plus a source-regression check that AdminUpgrades.tsx wires a Cancel button
 * to the new endpoint when progress.pending > 0.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-upgrade-cancel-${process.pid}.sqlite`);
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

describe('POST /v1/admin/upgrade/:directiveId/cancel', () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;
  let cookieView: string;
  let fleetTokenInst1: string;

  beforeEach(async () => {
    cleanup();
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
    // Second org, separate admin — used to assert tenant isolation.
    await createPasswordUser(ctx.db, 'org-b', 'admin-b@x', 'longenough1', 'admin');
    cookieAdmin = await loginAs(app, 'admin@x', 'longenough1');
    cookieView = await loginAs(app, 'view@x', 'longenough1');

    await seedInstallation(ctx.db, 'org-a', 'inst-1');
    await seedInstallation(ctx.db, 'org-a', 'inst-2');
    await seedInstallation(ctx.db, 'org-a', 'inst-3');
    fleetTokenInst1 = await issueApiKey(ctx.db, 'org-a', 'inst-1-token', { installationId: 'inst-1' } as any);
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  async function issueDirectiveAll(): Promise<string> {
    const r = await supertest(app)
      .post('/v1/admin/upgrade')
      .set('Cookie', cookieAdmin)
      .send({ targetVersion: '0.3.1', scope: { type: 'all' } });
    expect(r.status).toBe(201);
    return r.body.directiveId;
  }

  it('rejects non-admin viewer with 403', async () => {
    const directiveId = await issueDirectiveAll();
    const r = await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieView)
      .send({});
    expect(r.status).toBe(403);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const directiveId = await issueDirectiveAll();
    const r = await supertest(app).post(`/v1/admin/upgrade/${directiveId}/cancel`).send({});
    expect(r.status).toBe(401);
  });

  it('returns 404 for an unknown directive id', async () => {
    const r = await supertest(app)
      .post('/v1/admin/upgrade/00000000-0000-0000-0000-000000000000/cancel')
      .set('Cookie', cookieAdmin)
      .send({});
    expect(r.status).toBe(404);
  });

  it('returns 404 when the directive belongs to a different org', async () => {
    const directiveId = await issueDirectiveAll();
    const cookieAdminB = await loginAs(app, 'admin-b@x', 'longenough1');
    const r = await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdminB)
      .send({});
    expect(r.status).toBe(404);
    // And the original directive's targets must not have been touched.
    const states = await ctx.db.all<{ state: string }>(
      'SELECT state FROM upgrade_directive_targets WHERE directive_id = ?',
      [directiveId],
    );
    expect(states.every(s => s.state === 'pending')).toBe(true);
  });

  it('flips every pending target to cancelled and reports the count', async () => {
    const directiveId = await issueDirectiveAll();
    const r = await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.cancelledCount).toBe(3);
    expect(r.body.leftAlone).toEqual({ in_progress: 0, succeeded: 0, failed: 0 });

    const rows = await ctx.db.all<{ state: string }>(
      'SELECT state FROM upgrade_directive_targets WHERE directive_id = ?',
      [directiveId],
    );
    expect(rows.every(s => s.state === 'cancelled')).toBe(true);
  });

  it('leaves in_progress / succeeded / failed targets untouched', async () => {
    const directiveId = await issueDirectiveAll();
    // Manually mutate two targets to simulate fleet progress before the cancel.
    await ctx.db.run(
      `UPDATE upgrade_directive_targets SET state = 'in_progress'
       WHERE directive_id = ? AND installation_id = ?`,
      [directiveId, 'inst-1'],
    );
    await ctx.db.run(
      `UPDATE upgrade_directive_targets SET state = 'succeeded', result_version = '0.3.1'
       WHERE directive_id = ? AND installation_id = ?`,
      [directiveId, 'inst-2'],
    );

    const r = await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.cancelledCount).toBe(1);
    expect(r.body.leftAlone).toEqual({ in_progress: 1, succeeded: 1, failed: 0 });

    const byInst = await ctx.db.all<{ installation_id: string; state: string }>(
      'SELECT installation_id, state FROM upgrade_directive_targets WHERE directive_id = ?',
      [directiveId],
    );
    const map = Object.fromEntries(byInst.map(r => [r.installation_id, r.state]));
    expect(map['inst-1']).toBe('in_progress');
    expect(map['inst-2']).toBe('succeeded');
    expect(map['inst-3']).toBe('cancelled');
  });

  it('is idempotent: a second cancel returns 200 with cancelledCount=0', async () => {
    const directiveId = await issueDirectiveAll();
    await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({});
    const r = await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.cancelledCount).toBe(0);
  });

  it('drops the directive off the fleet poll once cancelled', async () => {
    const directiveId = await issueDirectiveAll();
    // Sanity: pending directive shows up before cancel.
    const before = await supertest(app)
      .get('/v1/upgrade-directive')
      .set('Authorization', `Bearer ${fleetTokenInst1}`);
    expect(before.status).toBe(200);
    expect(before.body.directiveId).toBe(directiveId);

    await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({});

    const after = await supertest(app)
      .get('/v1/upgrade-directive')
      .set('Authorization', `Bearer ${fleetTokenInst1}`);
    expect(after.status).toBe(204);
  });

  it('cancelled targets do not block a fresh directive (single-pending guard treats them as terminal)', async () => {
    const directiveId = await issueDirectiveAll();
    await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({});

    const fresh = await supertest(app)
      .post('/v1/admin/upgrade')
      .set('Cookie', cookieAdmin)
      .send({ targetVersion: '0.3.1', scope: { type: 'all' }, confirmDowngrade: true });
    expect(fresh.status).toBe(201);
    expect(fresh.body.directiveId).not.toBe(directiveId);
  });

  it('surfaces a `cancelled` count in GET /v1/admin/upgrade progress', async () => {
    const directiveId = await issueDirectiveAll();
    await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({});

    const list = await supertest(app).get('/v1/admin/upgrade').set('Cookie', cookieAdmin);
    expect(list.status).toBe(200);
    const d = list.body.directives.find((x: any) => x.directiveId === directiveId);
    expect(d).toBeTruthy();
    expect(d.progress.cancelled).toBe(3);
    expect(d.progress.pending).toBe(0);
    // Per-target rows expose the cancelled state.
    expect(d.targets.every((t: any) => t.state === 'cancelled')).toBe(true);
  });
});

describe('AdminUpgrades.tsx — Cancel pending control (source regression)', () => {
  it('declares a Cancel button that POSTs to /v1/admin/upgrade/:id/cancel', () => {
    const PAGE_PATH = path.resolve(__dirname, '../../../hub-ui/src/pages/AdminUpgrades.tsx');
    const src = fs.readFileSync(PAGE_PATH, 'utf8');
    // Endpoint wired up.
    expect(src).toMatch(/\/v1\/admin\/upgrade\/\$\{[^}]+\}\/cancel/);
    // User-visible label.
    expect(src).toMatch(/Cancel pending/);
    // Cancelled count surfaced somewhere on the directive header.
    expect(src).toMatch(/cancelled/);
  });
});
