import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-flow-avail-${process.pid}.sqlite`);
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

const sampleDef = (name = 'F') => ({
  name,
  description: '',
  steps: [
    { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
    { id: 's1', name: 'work', label: 'Work', order: 1 },
    { id: 's2', name: 'done', label: 'Done', order: 2, isAnchor: true },
  ],
});

describe('flow org_available — admin availability toggle', () => {
  let app: any;
  let ctx: any;
  let cookieA: string;
  let cookieB: string;

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
    await ctx.db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', ['org-b', 'org-b']);
    await ctx.db.run('INSERT OR IGNORE INTO auth_config (org_id, password_enabled) VALUES (?, 1)', ['org-b']);
    await createPasswordUser(ctx.db, 'org-a', 'admin-a@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org-b', 'admin-b@x', 'longenough1', 'admin');
    cookieA = await loginAs(app, 'admin-a@x', 'longenough1');
    cookieB = await loginAs(app, 'admin-b@x', 'longenough1');
  });

  afterEach(async () => {
    // Drain in-flight responses before closing the DB — see helpers/drainApp.ts
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  it('newly created flow is not org-available by default', async () => {
    const f = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef('NewFlow') })).body;

    const list = await supertest(app).get('/v1/admin/flows').set('Cookie', cookieA);
    const found = list.body.find((flow: any) => flow.id === f.id);
    expect(found).toBeDefined();
    expect(found.orgAvailable).toBe(false);
  });

  it('PUT /v1/admin/flows/:id/availability { available: true } marks it available', async () => {
    const f = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef('AvailFlow') })).body;

    const toggleR = await supertest(app)
      .put(`/v1/admin/flows/${f.id}/availability`)
      .set('Cookie', cookieA)
      .send({ available: true });
    expect(toggleR.status).toBe(200);

    const list = await supertest(app).get('/v1/admin/flows').set('Cookie', cookieA);
    const found = list.body.find((flow: any) => flow.id === f.id);
    expect(found.orgAvailable).toBe(true);
  });

  it('availability can be turned off again', async () => {
    const f = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef('ToggleFlow') })).body;

    // Turn on
    await supertest(app)
      .put(`/v1/admin/flows/${f.id}/availability`)
      .set('Cookie', cookieA)
      .send({ available: true });

    // Turn off
    const toggleOff = await supertest(app)
      .put(`/v1/admin/flows/${f.id}/availability`)
      .set('Cookie', cookieA)
      .send({ available: false });
    expect(toggleOff.status).toBe(200);

    const list = await supertest(app).get('/v1/admin/flows').set('Cookie', cookieA);
    const found = list.body.find((flow: any) => flow.id === f.id);
    expect(found.orgAvailable).toBe(false);
  });

  it('setting a flow as the org default also makes it org-available', async () => {
    const f = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef('DefaultFlow') })).body;

    const assignR = await supertest(app)
      .put('/v1/admin/flow-assignments')
      .set('Cookie', cookieA)
      .send({ scope: 'org', flowId: f.id });
    expect(assignR.status).toBe(200);

    const list = await supertest(app).get('/v1/admin/flows').set('Cookie', cookieA);
    const found = list.body.find((flow: any) => flow.id === f.id);
    expect(found.orgAvailable).toBe(true);
  });

  it('multiple flows can be org-available simultaneously', async () => {
    const f1 = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef('FlowA') })).body;
    const f2 = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef('FlowB') })).body;

    await supertest(app)
      .put(`/v1/admin/flows/${f1.id}/availability`)
      .set('Cookie', cookieA)
      .send({ available: true });
    await supertest(app)
      .put(`/v1/admin/flows/${f2.id}/availability`)
      .set('Cookie', cookieA)
      .send({ available: true });

    const list = await supertest(app).get('/v1/admin/flows').set('Cookie', cookieA);
    const found1 = list.body.find((flow: any) => flow.id === f1.id);
    const found2 = list.body.find((flow: any) => flow.id === f2.id);
    expect(found1.orgAvailable).toBe(true);
    expect(found2.orgAvailable).toBe(true);
  });

  it('availability toggle is org-isolated', async () => {
    const f = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef('OrgAFlow') })).body;

    // org-b tries to toggle org-a's flow -> 404
    const bad = await supertest(app)
      .put(`/v1/admin/flows/${f.id}/availability`)
      .set('Cookie', cookieB)
      .send({ available: true });
    expect(bad.status).toBe(404);
  });
});