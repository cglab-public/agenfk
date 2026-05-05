import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-flows-test-${process.pid}.sqlite`);
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

const sampleDefinition = () => ({
  name: 'My Custom Flow',
  description: 'For tests',
  steps: [
    { id: 's0', name: 'todo',    label: 'Todo',    order: 0, isAnchor: true },
    { id: 's1', name: 'work',    label: 'Working', order: 1, exitCriteria: 'Code compiles' },
    { id: 's2', name: 'review',  label: 'Review',  order: 2 },
    { id: 's3', name: 'done',    label: 'Done',    order: 3, isAnchor: true },
  ],
});

describe('admin flow routes', () => {
  let app: any;
  let ctx: any;

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
    // Two orgs: org-a (default) and org-b for isolation tests.
    await ctx.db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', ['org-b', 'org-b']);
    await ctx.db.run(
      'INSERT OR IGNORE INTO auth_config (org_id, password_enabled) VALUES (?, 1)',
      ['org-b'],
    );
    await createPasswordUser(ctx.db, 'org-a', 'admin-a@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org-a', 'view-a@x',  'longenough1', 'viewer');
    await createPasswordUser(ctx.db, 'org-b', 'admin-b@x', 'longenough1', 'admin');
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  // ── auth gating ────────────────────────────────────────────────────────────
  it('rejects non-admin sessions on flows endpoints', async () => {
    const cookie = await loginAs(app, 'view-a@x', 'longenough1');
    const r1 = await supertest(app).get('/v1/admin/flows').set('Cookie', cookie);
    expect(r1.status).toBe(403);
    const r2 = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie).send({ definition: sampleDefinition() });
    expect(r2.status).toBe(403);
    const r3 = await supertest(app).get('/v1/admin/flow-assignments').set('Cookie', cookie);
    expect(r3.status).toBe(403);
  });

  // ── CRUD ───────────────────────────────────────────────────────────────────
  it('creates a flow with source=hub and version=1', async () => {
    const cookie = await loginAs(app, 'admin-a@x', 'longenough1');
    const r = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie)
      .send({ definition: sampleDefinition() });
    expect(r.status).toBe(201);
    expect(r.body.id).toBeTruthy();
    expect(r.body.name).toBe('My Custom Flow');
    expect(r.body.source).toBe('hub');
    expect(r.body.version).toBe(1);
    expect(r.body.definition.steps).toHaveLength(4);
  });

  it('rejects invalid definition (missing steps)', async () => {
    const cookie = await loginAs(app, 'admin-a@x', 'longenough1');
    const r = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie)
      .send({ definition: { name: 'Bad', steps: [] } });
    expect(r.status).toBe(400);
  });

  it('lists flows for the caller org only (org isolation)', async () => {
    const cookieA = await loginAs(app, 'admin-a@x', 'longenough1');
    const cookieB = await loginAs(app, 'admin-b@x', 'longenough1');
    await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA)
      .send({ definition: { ...sampleDefinition(), name: 'A-Flow' } });
    await supertest(app).post('/v1/admin/flows').set('Cookie', cookieB)
      .send({ definition: { ...sampleDefinition(), name: 'B-Flow' } });

    const listA = await supertest(app).get('/v1/admin/flows').set('Cookie', cookieA);
    expect(listA.status).toBe(200);
    expect(listA.body.map((f: any) => f.name)).toEqual(['A-Flow']);

    const listB = await supertest(app).get('/v1/admin/flows').set('Cookie', cookieB);
    expect(listB.body.map((f: any) => f.name)).toEqual(['B-Flow']);
  });

  it('GET :id returns the flow; 404 across orgs', async () => {
    const cookieA = await loginAs(app, 'admin-a@x', 'longenough1');
    const cookieB = await loginAs(app, 'admin-b@x', 'longenough1');
    const created = await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA)
      .send({ definition: sampleDefinition() });
    const id = created.body.id;

    const ok = await supertest(app).get(`/v1/admin/flows/${id}`).set('Cookie', cookieA);
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(id);

    const cross = await supertest(app).get(`/v1/admin/flows/${id}`).set('Cookie', cookieB);
    expect(cross.status).toBe(404);
  });

  it('PUT bumps version and persists changes', async () => {
    const cookie = await loginAs(app, 'admin-a@x', 'longenough1');
    const created = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie)
      .send({ definition: sampleDefinition() });
    const id = created.body.id;

    const updated = { ...sampleDefinition(), name: 'Renamed' };
    const r = await supertest(app).put(`/v1/admin/flows/${id}`).set('Cookie', cookie)
      .send({ definition: updated });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(2);
    expect(r.body.name).toBe('Renamed');
  });

  it('PUT cannot cross org boundaries (404)', async () => {
    const cookieA = await loginAs(app, 'admin-a@x', 'longenough1');
    const cookieB = await loginAs(app, 'admin-b@x', 'longenough1');
    const created = await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA)
      .send({ definition: sampleDefinition() });
    const id = created.body.id;
    const r = await supertest(app).put(`/v1/admin/flows/${id}`).set('Cookie', cookieB)
      .send({ definition: { ...sampleDefinition(), name: 'pwn' } });
    expect(r.status).toBe(404);
  });

  it('DELETE removes the flow', async () => {
    const cookie = await loginAs(app, 'admin-a@x', 'longenough1');
    const created = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie)
      .send({ definition: sampleDefinition() });
    const id = created.body.id;
    const del = await supertest(app).delete(`/v1/admin/flows/${id}`).set('Cookie', cookie);
    expect(del.status).toBe(200);
    const after = await supertest(app).get(`/v1/admin/flows/${id}`).set('Cookie', cookie);
    expect(after.status).toBe(404);
  });

  it('DELETE refuses if the flow is currently assigned to the org', async () => {
    const cookie = await loginAs(app, 'admin-a@x', 'longenough1');
    const created = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie)
      .send({ definition: sampleDefinition() });
    const id = created.body.id;
    await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookie)
      .send({ flowId: id });
    const del = await supertest(app).delete(`/v1/admin/flows/${id}`).set('Cookie', cookie);
    expect(del.status).toBe(409);
  });

  // ── Assignments ────────────────────────────────────────────────────────────
  it('GET /flow-assignments returns null when none set', async () => {
    const cookie = await loginAs(app, 'admin-a@x', 'longenough1');
    const r = await supertest(app).get('/v1/admin/flow-assignments').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ flowId: null });
  });

  it('PUT /flow-assignments sets and overwrites the org default flow', async () => {
    const cookie = await loginAs(app, 'admin-a@x', 'longenough1');
    const f1 = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie)
      .send({ definition: { ...sampleDefinition(), name: 'F1' } });
    const f2 = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie)
      .send({ definition: { ...sampleDefinition(), name: 'F2' } });

    const a1 = await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookie)
      .send({ flowId: f1.body.id });
    expect(a1.status).toBe(200);
    expect(a1.body.flowId).toBe(f1.body.id);

    const a2 = await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookie)
      .send({ flowId: f2.body.id });
    expect(a2.status).toBe(200);
    expect(a2.body.flowId).toBe(f2.body.id);

    const get = await supertest(app).get('/v1/admin/flow-assignments').set('Cookie', cookie);
    expect(get.body.flowId).toBe(f2.body.id);
  });

  it('PUT /flow-assignments rejects flowId from another org', async () => {
    const cookieA = await loginAs(app, 'admin-a@x', 'longenough1');
    const cookieB = await loginAs(app, 'admin-b@x', 'longenough1');
    const fa = await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA)
      .send({ definition: sampleDefinition() });
    const r = await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieB)
      .send({ flowId: fa.body.id });
    expect(r.status).toBe(404);
  });

  it('PUT /flow-assignments accepts null to clear assignment', async () => {
    const cookie = await loginAs(app, 'admin-a@x', 'longenough1');
    const f = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie)
      .send({ definition: sampleDefinition() });
    await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookie)
      .send({ flowId: f.body.id });
    const cleared = await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookie)
      .send({ flowId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.flowId).toBeNull();
  });
});
