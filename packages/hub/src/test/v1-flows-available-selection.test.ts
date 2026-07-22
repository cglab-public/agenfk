import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-flows-avail-sel-${process.pid}.sqlite`);
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

const sampleDef = (name: string) => ({
  name,
  description: '',
  steps: [
    { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
    { id: 's1', name: 'work', label: 'Work', order: 1 },
    { id: 's2', name: 'done', label: 'Done', order: 2, isAnchor: true },
  ],
});

async function seedFlow(app: any, cookie: string, name: string): Promise<string> {
  const r = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie)
    .send({ definition: sampleDef(name) });
  return r.body.id;
}

async function assign(app: any, cookie: string, scope: string, targetId: string | null, flowId: string | null) {
  const body: any = { scope, flowId };
  if (targetId !== null) body.targetId = targetId;
  return supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookie).send(body);
}

async function markAvailable(app: any, cookie: string, flowId: string) {
  return supertest(app)
    .put(`/v1/admin/flows/${flowId}/availability`)
    .set('Cookie', cookie)
    .send({ available: true });
}

async function seedProjectOwnership(app: any, ctx: any, orgId: string, installationId: string, projectId: string) {
  const seedKey = await issueApiKey(ctx.db, orgId, 'seed-' + installationId);
  return supertest(app).post('/v1/events').set('Authorization', `Bearer ${seedKey}`).send({
    events: [{
      eventId: 'e-' + Math.random().toString(36).slice(2),
      installationId, orgId,
      occurredAt: '2026-05-03T10:00:00Z',
      actor: { osUser: 'x', gitName: 'X', gitEmail: 'x@x' },
      type: 'item.created', projectId, itemId: 'i1', payload: {},
    }],
  });
}

describe('GET /v1/flows/available & PUT /v1/flows/selection', () => {
  let app: any;
  let ctx: any;
  let cookie: string;
  let cookieB: string;
  let token: string;
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
    ctx = out.ctx;

    // org-a admin
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    cookie = await loginAs(app, 'admin@x', 'longenough1');

    // org-b — second org with its own admin
    await ctx.db.run(
      "INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?, ?, datetime('now'))",
      ['org-b', 'Org B'],
    );
    await ctx.db.run(
      "INSERT OR IGNORE INTO auth_config (org_id, password_enabled) VALUES (?, 1)",
      ['org-b'],
    );
    await createPasswordUser(ctx.db, 'org-b', 'admin-b@x', 'longenough1', 'admin');
    cookieB = await loginAs(app, 'admin-b@x', 'longenough1');

    await ctx.db.run("INSERT INTO installations (id, org_id, first_seen, last_seen) VALUES (?, ?, datetime('now'), datetime('now'))", ['inst-a', 'org-a']);
    await ctx.db.run("INSERT INTO installations (id, org_id, first_seen, last_seen) VALUES (?, ?, datetime('now'), datetime('now'))", ['inst-b', 'org-b']);
    token = await issueApiKey(ctx.db, 'org-a', 'client', { installationId: 'inst-a' });
    tokenB = await issueApiKey(ctx.db, 'org-b', 'clientB', { installationId: 'inst-b' });
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  // -----------------------------------------------------------------------
  // GET /v1/flows/available
  // -----------------------------------------------------------------------

  it('requires api key', async () => {
    const r = await supertest(app).get('/v1/flows/available');
    expect(r.status).toBe(401);
  });

  it('returns only org-available flows', async () => {
    const flowA = await seedFlow(app, cookie, 'Flow A');
    const flowB = await seedFlow(app, cookie, 'Flow B');
    const flowC = await seedFlow(app, cookie, 'Flow C');

    // Mark A and B available; leave C unavailable
    await markAvailable(app, cookie, flowA);
    await markAvailable(app, cookie, flowB);

    const r = await supertest(app)
      .get('/v1/flows/available')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);

    const ids = new Set(r.body.flows.map((f: any) => f.id));
    expect(ids).toEqual(new Set([flowA, flowB]));
    expect(ids.has(flowC)).toBe(false);
  });

  it('marks the org default', async () => {
    const flowA = await seedFlow(app, cookie, 'Flow A');
    const flowB = await seedFlow(app, cookie, 'Flow B');

    await markAvailable(app, cookie, flowA);
    await markAvailable(app, cookie, flowB);

    // Set flowA as org default
    await assign(app, cookie, 'org', null, flowA);

    const r = await supertest(app)
      .get('/v1/flows/available')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.defaultFlowId).toBe(flowA);

    const entryA = r.body.flows.find((f: any) => f.id === flowA);
    const entryB = r.body.flows.find((f: any) => f.id === flowB);
    expect(entryA.isDefault).toBe(true);
    expect(entryB.isDefault).toBe(false);
  });

  it('org isolated', async () => {
    const flowA = await seedFlow(app, cookie, 'Flow A');
    await markAvailable(app, cookie, flowA);

    // org-b client queries — should see nothing
    const r = await supertest(app)
      .get('/v1/flows/available')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(r.status).toBe(200);
    expect(r.body.flows).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // PUT /v1/flows/selection
  // -----------------------------------------------------------------------

  it('requires api key', async () => {
    const r = await supertest(app)
      .put('/v1/flows/selection')
      .send({ projectId: 'p1', flowId: 'x' });
    expect(r.status).toBe(401);
  });

  it('requires projectId', async () => {
    const flowA = await seedFlow(app, cookie, 'Flow A');
    await markAvailable(app, cookie, flowA);

    const r = await supertest(app)
      .put('/v1/flows/selection')
      .set('Authorization', `Bearer ${token}`)
      .send({ flowId: flowA });
    expect(r.status).toBe(400);
  });

  it('selecting an available flow writes a project assignment', async () => {
    const flowA = await seedFlow(app, cookie, 'Flow A');
    await markAvailable(app, cookie, flowA);

    // Select flowA for proj-1
    const sel = await supertest(app)
      .put('/v1/flows/selection')
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId: 'proj-1', flowId: flowA });
    expect(sel.status).toBe(200);

    // Verify via active endpoint
    const active = await supertest(app)
      .get('/v1/flows/active?projectId=proj-1')
      .set('Authorization', `Bearer ${token}`);
    expect(active.status).toBe(200);
    expect(active.body.flow.id).toBe(flowA);
    expect(active.body.scope).toBe('project');
  });

  it('rejects a flow that is not org-available', async () => {
    const flowC = await seedFlow(app, cookie, 'Flow C');
    // Do NOT mark flowC available

    const r = await supertest(app)
      .put('/v1/flows/selection')
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId: 'proj-1', flowId: flowC });
    expect(r.status).toBe(400);
  });

  it('rejects a flow from another org', async () => {
    // Seed and mark available in org-a
    const flowA = await seedFlow(app, cookie, 'Flow A');
    await markAvailable(app, cookie, flowA);

    // org-b client tries to select org-a's flow
    const r = await supertest(app)
      .put('/v1/flows/selection')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ projectId: 'proj-1', flowId: flowA });
    expect(r.status).toBe(404);
  });

  it('selection requires an installation-bound api key', async () => {
    const A = await seedFlow(app, cookie, 'A'); await markAvailable(app, cookie, A);
    const noInst = await issueApiKey(ctx.db, 'org-a', 'noinst'); // no installation
    const r = await supertest(app).put('/v1/flows/selection').set('Authorization', `Bearer ${noInst}`)
      .send({ projectId: 'proj-x', flowId: A });
    expect(r.status).toBe(403);
  });

  it('rejects selecting for a project owned by another installation', async () => {
    const A = await seedFlow(app, cookie, 'A'); await markAvailable(app, cookie, A);
    await seedProjectOwnership(app, ctx, 'org-a', 'inst-other', 'owned-elsewhere');
    const r = await supertest(app).put('/v1/flows/selection').set('Authorization', `Bearer ${token}`)
      .send({ projectId: 'owned-elsewhere', flowId: A });
    expect(r.status).toBe(403);
  });

  it('allows selecting for a project owned by the caller installation', async () => {
    const A = await seedFlow(app, cookie, 'A'); await markAvailable(app, cookie, A);
    await seedProjectOwnership(app, ctx, 'org-a', 'inst-a', 'mine');
    const r = await supertest(app).put('/v1/flows/selection').set('Authorization', `Bearer ${token}`)
      .send({ projectId: 'mine', flowId: A });
    expect(r.status).toBe(200);
    const active = await supertest(app).get('/v1/flows/active?projectId=mine').set('Authorization', `Bearer ${token}`);
    expect(active.body.flow.id).toBe(A);
  });

  it('rejects a non-string flowId', async () => {
    const r = await supertest(app).put('/v1/flows/selection').set('Authorization', `Bearer ${token}`)
      .send({ projectId: 'p1', flowId: 123 });
    expect(r.status).toBe(400);
  });

  it('a second selection overwrites the first', async () => {
    const A = await seedFlow(app, cookie, 'A'); await markAvailable(app, cookie, A);
    const B = await seedFlow(app, cookie, 'B'); await markAvailable(app, cookie, B);
    await supertest(app).put('/v1/flows/selection').set('Authorization', `Bearer ${token}`).send({ projectId: 'p2', flowId: A });
    await supertest(app).put('/v1/flows/selection').set('Authorization', `Bearer ${token}`).send({ projectId: 'p2', flowId: B });
    const active = await supertest(app).get('/v1/flows/active?projectId=p2').set('Authorization', `Bearer ${token}`);
    expect(active.body.flow.id).toBe(B);
  });

  it('clearing selection with flowId:null removes the project assignment', async () => {
    const flowA = await seedFlow(app, cookie, 'Flow A');
    await markAvailable(app, cookie, flowA);

    // Select first
    await supertest(app)
      .put('/v1/flows/selection')
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId: 'proj-1', flowId: flowA });

    // Now clear
    const clr = await supertest(app)
      .put('/v1/flows/selection')
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId: 'proj-1', flowId: null });
    expect(clr.status).toBe(200);

    // Verify no assignment remains (no org default set, so falls through to null)
    const active = await supertest(app)
      .get('/v1/flows/active?projectId=proj-1')
      .set('Authorization', `Bearer ${token}`);
    expect(active.status).toBe(200);
    expect(active.body.flow).toBeNull();
  });
});