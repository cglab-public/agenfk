import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { loginAs } from './helpers/loginAs';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';

/**
 * A REAL listening server, so drainApp has something to drain (BUG 2bd7ee36).
 *
 * `drainApp` calls closeIdleConnections/closeAllConnections, which exist on
 * http.Server and NOT on an Express app — and `createHubApp` returns an
 * Express app. With `?.` those calls vanished silently, so the helper written
 * to fix this suite's flakiness never did anything. Module scope because a
 * file can hold several describes, each reassigning `app`.
 */
let __server: any;

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-flows-active-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};


const sampleDef = (name = 'Active Flow') => ({
  name,
  description: 'For tests',
  steps: [
    { id: 's0', name: 'todo',  label: 'Todo',   order: 0, isAnchor: true },
    { id: 's1', name: 'work',  label: 'Work',   order: 1 },
    { id: 's2', name: 'done',  label: 'Done',   order: 2, isAnchor: true },
  ],
});

describe('GET /v1/flows/active', () => {
  let app: any;
  let ctx: any;
  let tokenA: string;
  let tokenB: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a',
    });
    app = out.app;
    if (__server) await new Promise<void>(r => __server.close(() => r()));
    __server = app.listen(0);
    ctx = out.ctx;
    await ctx.db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', ['org-b', 'org-b']);
    await ctx.db.run('INSERT OR IGNORE INTO auth_config (org_id, password_enabled) VALUES (?, 1)', ['org-b']);
    await createPasswordUser(ctx.db, 'org-a', 'admin-a@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org-b', 'admin-b@x', 'longenough1', 'admin');
    tokenA = await issueApiKey(ctx.db, 'org-a', 'a-laptop');
    tokenB = await issueApiKey(ctx.db, 'org-b', 'b-laptop');
  });

  afterEach(async () => {
    // Drain in-flight responses before closing the DB — see helpers/drainApp.ts
    await drainApp(__server);
    await ctx.db.close();
    cleanup();
  });

  it('rejects unauthenticated requests', async () => {
    const r = await supertest(__server).get('/v1/flows/active');
    expect(r.status).toBe(401);
  });

  it('returns { flow: null } when org has no assignment', async () => {
    const r = await supertest(__server).get('/v1/flows/active').set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ flow: null });
  });

  it('returns the assigned flow with hubVersion + ETag when assigned', async () => {
    const cookie = await loginAs(app, 'admin-a@x', 'longenough1');
    const created = await supertest(__server).post('/v1/admin/flows').set('Cookie', cookie)
      .send({ definition: sampleDef() });
    await supertest(__server).put('/v1/admin/flow-assignments').set('Cookie', cookie)
      .send({ flowId: created.body.id });

    const r = await supertest(__server).get('/v1/flows/active').set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.flow).toBeTruthy();
    expect(r.body.flow.id).toBe(created.body.id);
    expect(r.body.flow.name).toBe('Active Flow');
    expect(r.body.hubVersion).toBe(1);
    expect(r.headers.etag).toBe(`W/"1:org:"`);
  });

  it('returns 304 when If-None-Match matches the current ETag', async () => {
    const cookie = await loginAs(app, 'admin-a@x', 'longenough1');
    const created = await supertest(__server).post('/v1/admin/flows').set('Cookie', cookie)
      .send({ definition: sampleDef() });
    await supertest(__server).put('/v1/admin/flow-assignments').set('Cookie', cookie)
      .send({ flowId: created.body.id });

    const r = await supertest(__server).get('/v1/flows/active')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('If-None-Match', 'W/"1:org:"');
    expect(r.status).toBe(304);
  });

  it('bumps version on edit and breaks the cached ETag', async () => {
    const cookie = await loginAs(app, 'admin-a@x', 'longenough1');
    const created = await supertest(__server).post('/v1/admin/flows').set('Cookie', cookie)
      .send({ definition: sampleDef() });
    await supertest(__server).put('/v1/admin/flow-assignments').set('Cookie', cookie)
      .send({ flowId: created.body.id });
    // Edit the flow → version 2
    await supertest(__server).put(`/v1/admin/flows/${created.body.id}`).set('Cookie', cookie)
      .send({ definition: { ...sampleDef(), name: 'Renamed' } });

    const stale = await supertest(__server).get('/v1/flows/active')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('If-None-Match', 'W/"1:org:"');
    expect(stale.status).toBe(200);
    expect(stale.body.hubVersion).toBe(2);
    expect(stale.body.flow.name).toBe('Renamed');
  });

  it('isolates orgs — org-b token never sees org-a flow', async () => {
    const cookieA = await loginAs(app, 'admin-a@x', 'longenough1');
    const created = await supertest(__server).post('/v1/admin/flows').set('Cookie', cookieA)
      .send({ definition: sampleDef() });
    await supertest(__server).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ flowId: created.body.id });

    const r = await supertest(__server).get('/v1/flows/active').set('Authorization', `Bearer ${tokenB}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ flow: null });
  });
});
