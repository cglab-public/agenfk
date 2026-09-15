// Parent side of group upgrades (CGLAB-183, task 1).
//
// A parent hub sends a target version to its child hubs, which each fan it out
// over their own installations. This half is the record and the feed: the
// dispatch tables, the admin endpoints, and the `upgrade.dispatch` arm of
// /v1/federation/directives.
//
// The rules carried over from flow dispatch, deliberately and identically:
//  - serving a directive is NOT the upgrade landing; a hub that polled stays
//    `pending` until it reports (that report is task 3);
//  - scope 'all' means every current AND FUTURE child hub, so it is stored as
//    intent and resolved per poll, never expanded into target rows up front;
//  - the version is validated against the release allowlist at CREATE time,
//    the same gate POST /upgrade uses, so a bad version is refused where an
//    admin can read the error rather than on a child at 3am.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const SECRET = 'a'.repeat(64);
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-updispatch-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('parent hub: dispatching a group upgrade', () => {
  let app: any;
  let ctx: any;
  let cookie: string;

  async function enroll(name: string) {
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const r = await supertest(app).post('/v1/federation/enroll')
      .send({ inviteToken: inv.body.inviteToken, childHub: { name } });
    expect(r.status).toBe(200);
    return r.body as { token: string; childHubId: string };
  }

  const create = (body: Record<string, unknown>) =>
    supertest(app).post('/v1/admin/upgrade-dispatches').set('Cookie', cookie).send(body);

  const directives = (token: string) =>
    supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${token}`);

  const target = (dispatchId: string, childHubId: string) =>
    ctx.db.get<any>(
      'SELECT state, detail FROM upgrade_dispatch_targets WHERE dispatch_id = ? AND child_hub_id = ?',
      [dispatchId, childHubId],
    );

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org',
      releaseExists: async (v: string) => v === '1.2.3' || v === '1.0.0',
    } as any);
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login')
      .send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => {
    ctx.stopWorkers?.();
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  it('records a dispatch for the whole group', async () => {
    const r = await create({ targetVersion: '1.2.3', scope: 'all' });
    expect(r.status).toBe(200);
    expect(r.body.targetVersion).toBe('1.2.3');
    const row = await ctx.db.get<any>('SELECT * FROM upgrade_dispatches WHERE id = ?', [r.body.id]);
    expect(row.target_version).toBe('1.2.3');
    expect(row.scope_type).toBe('all');
    expect(row.org_id).toBe('org');
  });

  it('refuses a version that is not a real release, where the admin can read it', async () => {
    const r = await create({ targetVersion: '9.9.9', scope: 'all' });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/9\.9\.9/);
    expect(await ctx.db.get<any>('SELECT COUNT(*) AS n FROM upgrade_dispatches')).toMatchObject({ n: 0 });
  });

  it('refuses a malformed version before it ever asks the allowlist', async () => {
    expect((await create({ targetVersion: 'not-a-version', scope: 'all' })).status).toBe(400);
    expect((await create({ targetVersion: '', scope: 'all' })).status).toBe(400);
  });

  it('refuses an unknown scope', async () => {
    expect((await create({ targetVersion: '1.2.3', scope: 'everyone' })).status).toBe(400);
  });

  it('records the downgrade confirmation the admin gave, so the child need not ask again', async () => {
    const off = await create({ targetVersion: '1.2.3', scope: 'all' });
    const on = await create({ targetVersion: '1.0.0', scope: 'all', confirmDowngrade: true });
    const a = await ctx.db.get<any>('SELECT confirm_downgrade FROM upgrade_dispatches WHERE id = ?', [off.body.id]);
    const b = await ctx.db.get<any>('SELECT confirm_downgrade FROM upgrade_dispatches WHERE id = ?', [on.body.id]);
    expect(!!a.confirm_downgrade).toBe(false);
    expect(!!b.confirm_downgrade).toBe(true);
  });

  it('serves the directive to a child, and serving leaves it PENDING', async () => {
    const a = await enroll('alpha');
    const d = await create({ targetVersion: '1.2.3', scope: 'all' });

    const served = await directives(a.token);
    expect(served.status).toBe(200);
    expect(served.body.kind).toBe('upgrade.dispatch');
    expect(served.body.dispatchId).toBe(d.body.id);
    expect(served.body.targetVersion).toBe('1.2.3');
    expect(served.body.confirmDowngrade).toBe(false);

    // Serving is not landing. Only a report from the child moves this.
    expect((await target(d.body.id, a.childHubId)).state).toBe('pending');
  });

  it('carries the downgrade confirmation to the child', async () => {
    const a = await enroll('alpha');
    await create({ targetVersion: '1.0.0', scope: 'all', confirmDowngrade: true });
    expect((await directives(a.token)).body.confirmDowngrade).toBe(true);
  });

  it("reaches a hub that enrolled AFTER the dispatch, because 'all' means future hubs too", async () => {
    const d = await create({ targetVersion: '1.2.3', scope: 'all' });
    const late = await enroll('late');
    const served = await directives(late.token);
    expect(served.body.dispatchId).toBe(d.body.id);
    expect((await target(d.body.id, late.childHubId)).state).toBe('pending');
  });

  it('under scope selected, serves only the hubs that were named', async () => {
    const a = await enroll('alpha');
    const b = await enroll('beta');
    const d = await create({ targetVersion: '1.2.3', scope: 'selected', childHubIds: [a.childHubId] });
    expect(d.status).toBe(200);

    expect((await directives(a.token)).body.dispatchId).toBe(d.body.id);
    expect((await directives(b.token)).status).toBe(204);
  });

  it('refuses a selected dispatch that names nobody', async () => {
    expect((await create({ targetVersion: '1.2.3', scope: 'selected', childHubIds: [] })).status).toBe(400);
  });

  it('does not serve a cancelled dispatch', async () => {
    const a = await enroll('alpha');
    const d = await create({ targetVersion: '1.2.3', scope: 'all' });
    const c = await supertest(app).post(`/v1/admin/upgrade-dispatches/${d.body.id}/cancel`).set('Cookie', cookie);
    expect(c.status).toBe(200);
    expect((await directives(a.token)).status).toBe(204);
  });

  it('lists dispatches with their per-child-hub progress', async () => {
    const a = await enroll('alpha');
    const d = await create({ targetVersion: '1.2.3', scope: 'all' });
    await directives(a.token);

    const list = await supertest(app).get('/v1/admin/upgrade-dispatches').set('Cookie', cookie);
    expect(list.status).toBe(200);
    const row = list.body.dispatches.find((x: any) => x.id === d.body.id);
    expect(row.targetVersion).toBe('1.2.3');
    expect(row.targets).toHaveLength(1);
    expect(row.targets[0]).toMatchObject({ childHubId: a.childHubId, name: 'alpha', state: 'pending' });
  });

  it('serves the OLDEST outstanding directive first, whichever kind it is', async () => {
    // Both kinds share one feed and a child takes one per poll. Oldest-first
    // keeps them in the order the admin actually issued them, instead of one
    // kind starving the other.
    const a = await enroll('alpha');
    await ctx.db.run(
      `INSERT INTO flows (id, org_id, name, definition_json, source, version)
       VALUES (?, ?, ?, ?, 'hub', 1)`,
      ['f1', 'org', 'F', JSON.stringify({ name: 'F', steps: [{ id: 's0', name: 'T', order: 0 }] })],
    );
    const flowDispatch = await supertest(app).post('/v1/admin/flow-dispatches')
      .set('Cookie', cookie).send({ flowId: 'f1', scope: 'all' });
    expect(flowDispatch.status).toBe(200);
    await create({ targetVersion: '1.2.3', scope: 'all' });

    expect((await directives(a.token)).body.kind).toBe('flow.dispatch');
  });

  it('keeps another org\'s dispatch out of this hub\'s feed', async () => {
    const a = await enroll('alpha');
    await ctx.db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', ['org-b', 'org-b']);
    await ctx.db.run(
      `INSERT INTO upgrade_dispatches (id, org_id, target_version, scope_type, created_at)
       VALUES (?, ?, ?, 'all', ?)`,
      ['d-other', 'org-b', '1.2.3', new Date().toISOString()],
    );
    expect((await directives(a.token)).status).toBe(204);
  });

  it('needs an admin session to create, and a federation key to be served', async () => {
    const a = await enroll('alpha');
    expect((await supertest(app).post('/v1/admin/upgrade-dispatches')
      .send({ targetVersion: '1.2.3', scope: 'all' })).status).toBe(401);
    expect((await supertest(app).get('/v1/federation/directives').set('Cookie', cookie)).status).toBe(401);
    expect(a.token).toBeTruthy();
  });
});
