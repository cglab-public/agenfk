/**
 * Hub admin: FORCE-cancel a fleet upgrade directive (BUG 5707f067).
 *
 * A target stuck in state='in_progress' (agent died mid-upgrade or its
 * terminal fleet:upgrade:* event was lost) wedges the installation forever:
 * the single-pending guard blocks every new directive and the plain cancel
 * deliberately leaves in_progress alone.
 *
 * POST /v1/admin/upgrade/:directiveId/cancel with { force: true }:
 *   - flips pending AND in_progress targets to 'cancelled'
 *   - stamps finished_at + error_message on the force-cancelled in_progress rows
 *   - reports forcedCount alongside cancelledCount
 *   - unblocks the single-pending guard for a fresh directive
 * Without force the behavior is unchanged (in_progress left alone).
 *
 * Guard rail: a late `fleet:upgrade:started` event from a resurrected agent
 * must NOT flip a cancelled target back to in_progress (it would re-wedge);
 * a late terminal succeeded/failed report stays authoritative.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-upgrade-force-cancel-${process.pid}.sqlite`);
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

function upgradeEvent(type: string, installationId: string, directiveId: string, extra: any = {}) {
  return {
    eventId: randomUUID(),
    orgId: 'org-a',
    installationId,
    occurredAt: new Date('2026-05-02T10:00:00Z').toISOString(),
    type,
    actor: { osUser: 'tester' },
    payload: { directiveId, ...extra },
  };
}

describe('POST /v1/admin/upgrade/:directiveId/cancel { force: true }', () => {
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
      releaseExists: async (version: string) => version === '0.3.1',
    } as any);
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org-a', 'view@x', 'longenough1', 'viewer');
    cookieAdmin = await loginAs(app, 'admin@x', 'longenough1');
    cookieView = await loginAs(app, 'view@x', 'longenough1');

    await seedInstallation(ctx.db, 'org-a', 'inst-1');
    await seedInstallation(ctx.db, 'org-a', 'inst-2');
    await seedInstallation(ctx.db, 'org-a', 'inst-3');
    fleetTokenInst1 = await issueApiKey(ctx.db, 'org-a', 'inst-1-token', { installationId: 'inst-1' } as any);
  });

  afterEach(async () => {
    // Drain in-flight responses before closing the DB — see helpers/drainApp.ts
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  async function issueDirectiveAll(): Promise<string> {
    const r = await supertest(app)
      .post('/v1/admin/upgrade')
      .set('Cookie', cookieAdmin)
      .send({ targetVersion: '0.3.1', scope: { type: 'all' } });
    expect(r.status).toBe(201);
    return r.body.directiveId;
  }

  async function markInProgress(directiveId: string, installationId: string) {
    await ctx.db.run(
      `UPDATE upgrade_directive_targets SET state = 'in_progress', attempted_at = '2026-05-02T10:00:00Z'
       WHERE directive_id = ? AND installation_id = ?`,
      [directiveId, installationId],
    );
  }

  it('force-cancels in_progress targets along with pending ones', async () => {
    const directiveId = await issueDirectiveAll();
    await markInProgress(directiveId, 'inst-1');

    const r = await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({ force: true });
    expect(r.status).toBe(200);
    expect(r.body.cancelledCount).toBe(3);   // 2 pending + 1 in_progress
    expect(r.body.forcedCount).toBe(1);      // the in_progress one
    expect(r.body.leftAlone).toEqual({ in_progress: 0, succeeded: 0, failed: 0 });

    const rows = await ctx.db.all(
      'SELECT installation_id, state, finished_at, error_message FROM upgrade_directive_targets WHERE directive_id = ?',
      [directiveId],
    );
    expect(rows.every((t: any) => t.state === 'cancelled')).toBe(true);
    // The force-cancelled in_progress row records when and why it was closed.
    const forced = rows.find((t: any) => t.installation_id === 'inst-1')!;
    expect(forced.finished_at).toBeTruthy();
    expect(forced.error_message).toMatch(/force/i);
  });

  it('without force, in_progress is still left alone (regression)', async () => {
    const directiveId = await issueDirectiveAll();
    await markInProgress(directiveId, 'inst-1');

    const r = await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.cancelledCount).toBe(2);
    expect(r.body.leftAlone).toEqual({ in_progress: 1, succeeded: 0, failed: 0 });

    const row = await ctx.db.get(
      `SELECT state FROM upgrade_directive_targets WHERE directive_id = ? AND installation_id = 'inst-1'`,
      [directiveId],
    );
    expect(row!.state).toBe('in_progress');
  });

  it('force never touches succeeded/failed targets', async () => {
    const directiveId = await issueDirectiveAll();
    await ctx.db.run(
      `UPDATE upgrade_directive_targets SET state = 'succeeded', result_version = '0.3.1'
       WHERE directive_id = ? AND installation_id = 'inst-2'`,
      [directiveId],
    );
    await ctx.db.run(
      `UPDATE upgrade_directive_targets SET state = 'failed', error_message = 'boom'
       WHERE directive_id = ? AND installation_id = 'inst-3'`,
      [directiveId],
    );

    const r = await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({ force: true });
    expect(r.status).toBe(200);
    expect(r.body.cancelledCount).toBe(1); // only inst-1's pending row
    expect(r.body.forcedCount).toBe(0);
    expect(r.body.leftAlone).toEqual({ in_progress: 0, succeeded: 1, failed: 1 });

    const byInst = await ctx.db.all(
      'SELECT installation_id, state, error_message FROM upgrade_directive_targets WHERE directive_id = ?',
      [directiveId],
    );
    const map = Object.fromEntries(byInst.map((t: any) => [t.installation_id, t]));
    expect(map['inst-2'].state).toBe('succeeded');
    expect(map['inst-3'].state).toBe('failed');
    expect(map['inst-3'].error_message).toBe('boom'); // untouched
  });

  it('force requires admin (viewer gets 403)', async () => {
    const directiveId = await issueDirectiveAll();
    const r = await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieView)
      .send({ force: true });
    expect(r.status).toBe(403);
  });

  it('force-cancelled in_progress targets unblock the single-pending guard', async () => {
    const directiveId = await issueDirectiveAll();
    await markInProgress(directiveId, 'inst-1');

    // Sanity: the wedge exists — a fresh directive 409s on the in_progress target.
    const blocked = await supertest(app)
      .post('/v1/admin/upgrade')
      .set('Cookie', cookieAdmin)
      .send({ targetVersion: '0.3.1', scope: { type: 'installation', installationId: 'inst-1' }, confirmDowngrade: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.conflicts?.[0]?.conflictingDirectiveId).toBe(directiveId);

    await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({ force: true });

    const fresh = await supertest(app)
      .post('/v1/admin/upgrade')
      .set('Cookie', cookieAdmin)
      .send({ targetVersion: '0.3.1', scope: { type: 'installation', installationId: 'inst-1' }, confirmDowngrade: true });
    expect(fresh.status).toBe(201);
  });

  it('is idempotent: repeating force-cancel returns cancelledCount=0, forcedCount=0', async () => {
    const directiveId = await issueDirectiveAll();
    await markInProgress(directiveId, 'inst-1');
    await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({ force: true });
    const again = await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({ force: true });
    expect(again.status).toBe(200);
    expect(again.body.cancelledCount).toBe(0);
    expect(again.body.forcedCount).toBe(0);
  });

  it('a late fleet:upgrade:started cannot resurrect a cancelled target (would re-wedge)', async () => {
    const directiveId = await issueDirectiveAll();
    await markInProgress(directiveId, 'inst-1');
    await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({ force: true });

    // The zombie agent comes back and reports "started" for the old directive.
    const r = await supertest(app)
      .post('/v1/events')
      .set('Authorization', `Bearer ${fleetTokenInst1}`)
      .send({ events: [upgradeEvent('fleet:upgrade:started', 'inst-1', directiveId)] });
    expect(r.status).toBe(200);

    const row = await ctx.db.get(
      `SELECT state FROM upgrade_directive_targets WHERE directive_id = ? AND installation_id = 'inst-1'`,
      [directiveId],
    );
    expect(row!.state).toBe('cancelled');

    // And issuing a fresh directive for inst-1 still works.
    const fresh = await supertest(app)
      .post('/v1/admin/upgrade')
      .set('Cookie', cookieAdmin)
      .send({ targetVersion: '0.3.1', scope: { type: 'installation', installationId: 'inst-1' }, confirmDowngrade: true });
    expect(fresh.status).toBe(201);
  });

  it('a late terminal report (succeeded) remains authoritative over a force-cancel', async () => {
    const directiveId = await issueDirectiveAll();
    await markInProgress(directiveId, 'inst-1');
    await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({ force: true });

    // The upgrade actually finished — the terminal report should win: it is
    // more truthful and, being terminal, cannot re-wedge issuance.
    const r = await supertest(app)
      .post('/v1/events')
      .set('Authorization', `Bearer ${fleetTokenInst1}`)
      .send({ events: [upgradeEvent('fleet:upgrade:succeeded', 'inst-1', directiveId, { resultVersion: '0.3.1' })] });
    expect(r.status).toBe(200);

    const row = await ctx.db.get(
      `SELECT state, result_version, error_message FROM upgrade_directive_targets WHERE directive_id = ? AND installation_id = 'inst-1'`,
      [directiveId],
    );
    expect(row!.state).toBe('succeeded');
    expect(row!.result_version).toBe('0.3.1');
    // The stale force-cancel message must not linger on a succeeded row.
    expect(row!.error_message).toBeNull();
  });

  it('a late terminal failed report overwrites the force-cancel error_message with the real reason', async () => {
    const directiveId = await issueDirectiveAll();
    await markInProgress(directiveId, 'inst-1');
    await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({ force: true });

    const r = await supertest(app)
      .post('/v1/events')
      .set('Authorization', `Bearer ${fleetTokenInst1}`)
      .send({ events: [upgradeEvent('fleet:upgrade:failed', 'inst-1', directiveId, { error: 'install.mjs exit 1' })] });
    expect(r.status).toBe(200);

    const row = await ctx.db.get(
      `SELECT state, error_message FROM upgrade_directive_targets WHERE directive_id = ? AND installation_id = 'inst-1'`,
      [directiveId],
    );
    expect(row!.state).toBe('failed');
    expect(row!.error_message).toBe('install.mjs exit 1');
  });

  it('a late started is also blocked on plain-cancelled and terminal targets', async () => {
    const directiveId = await issueDirectiveAll();
    // inst-1: plain cancel while still pending.
    await supertest(app)
      .post(`/v1/admin/upgrade/${directiveId}/cancel`)
      .set('Cookie', cookieAdmin)
      .send({});

    const r = await supertest(app)
      .post('/v1/events')
      .set('Authorization', `Bearer ${fleetTokenInst1}`)
      .send({ events: [upgradeEvent('fleet:upgrade:started', 'inst-1', directiveId)] });
    expect(r.status).toBe(200);
    const cancelled = await ctx.db.get(
      `SELECT state FROM upgrade_directive_targets WHERE directive_id = ? AND installation_id = 'inst-1'`,
      [directiveId],
    );
    expect(cancelled!.state).toBe('cancelled');

    // And on a terminal row: force a succeeded state, then replay started.
    await ctx.db.run(
      `UPDATE upgrade_directive_targets SET state = 'succeeded' WHERE directive_id = ? AND installation_id = 'inst-1'`,
      [directiveId],
    );
    const r2 = await supertest(app)
      .post('/v1/events')
      .set('Authorization', `Bearer ${fleetTokenInst1}`)
      .send({ events: [upgradeEvent('fleet:upgrade:started', 'inst-1', directiveId)] });
    expect(r2.status).toBe(200);
    const terminal = await ctx.db.get(
      `SELECT state FROM upgrade_directive_targets WHERE directive_id = ? AND installation_id = 'inst-1'`,
      [directiveId],
    );
    expect(terminal!.state).toBe('succeeded');
  });
});

describe('AdminUpgrades.tsx — force-cancel affordance (source regression)', () => {
  it('offers the force path when in_progress targets remain', () => {
    const PAGE_PATH = path.resolve(__dirname, '../../../hub-ui/src/pages/AdminUpgrades.tsx');
    const src = fs.readFileSync(PAGE_PATH, 'utf8');
    // The cancel mutation can carry the force flag to the endpoint.
    expect(src).toMatch(/force/);
    // A distinct, explicit confirmation for force-cancelling in-flight upgrades.
    expect(src).toMatch(/[Ff]orce-cancel/);
    // The cancel control must be reachable when only in_progress targets remain
    // (previously it keyed off progress.pending alone).
    expect(src).toMatch(/in_progress/);
  });
});
