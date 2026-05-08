import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-fa-scopes-${process.pid}.sqlite`);
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

describe('flow_assignments — multi-scope CRUD', () => {
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

    // Seed installations row for each org so installation-scope tests have
    // valid target ids.
    await ctx.db.run(
      "INSERT INTO installations (id, org_id, first_seen, last_seen) VALUES (?, ?, datetime('now'), datetime('now'))",
      ['install-a-1', 'org-a'],
    );
    await ctx.db.run(
      "INSERT INTO installations (id, org_id, first_seen, last_seen) VALUES (?, ?, datetime('now'), datetime('now'))",
      ['install-b-1', 'org-b'],
    );
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  // ── GET shape ─────────────────────────────────────────────────────────────
  it('GET /flow-assignments returns an array for the new shape', async () => {
    const r = await supertest(app).get('/v1/admin/flow-assignments').set('Cookie', cookieA);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body).toEqual([]);
  });

  // ── PUT each scope ────────────────────────────────────────────────────────
  it('PUT scope=org sets the org default', async () => {
    const f = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef('Org-F') })).body;
    const r = await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ scope: 'org', flowId: f.id });
    expect(r.status).toBe(200);

    const list = await supertest(app).get('/v1/admin/flow-assignments').set('Cookie', cookieA);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ scope: 'org', targetId: '', flowId: f.id });
  });

  it('PUT scope=project requires targetId', async () => {
    const f = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef() })).body;
    const r = await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ scope: 'project', flowId: f.id });
    expect(r.status).toBe(400);
  });

  it('PUT scope=project sets a project override', async () => {
    const f = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef('Proj-F') })).body;
    const r = await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ scope: 'project', targetId: 'project-xyz', flowId: f.id });
    expect(r.status).toBe(200);

    const list = await supertest(app).get('/v1/admin/flow-assignments').set('Cookie', cookieA);
    const proj = list.body.find((a: any) => a.scope === 'project');
    expect(proj).toMatchObject({ scope: 'project', targetId: 'project-xyz', flowId: f.id });
  });

  it('PUT scope=installation validates targetId belongs to org', async () => {
    const f = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef() })).body;

    // Valid for own org.
    const ok = await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ scope: 'installation', targetId: 'install-a-1', flowId: f.id });
    expect(ok.status).toBe(200);

    // Foreign installation id -> 404.
    const bad = await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ scope: 'installation', targetId: 'install-b-1', flowId: f.id });
    expect(bad.status).toBe(404);
  });

  // ── Multiple coexisting scopes ────────────────────────────────────────────
  it('coexisting org + project + installation rows', async () => {
    const f = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef() })).body;

    await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ scope: 'org', flowId: f.id });
    await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ scope: 'project', targetId: 'p1', flowId: f.id });
    await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ scope: 'installation', targetId: 'install-a-1', flowId: f.id });

    const list = await supertest(app).get('/v1/admin/flow-assignments').set('Cookie', cookieA);
    expect(list.body).toHaveLength(3);
    const scopes = list.body.map((a: any) => a.scope).sort();
    expect(scopes).toEqual(['installation', 'org', 'project']);
  });

  it('upsert at same (scope, targetId) replaces, not appends', async () => {
    const f1 = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef('F1') })).body;
    const f2 = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef('F2') })).body;

    await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ scope: 'project', targetId: 'p1', flowId: f1.id });
    await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ scope: 'project', targetId: 'p1', flowId: f2.id });

    const list = await supertest(app).get('/v1/admin/flow-assignments').set('Cookie', cookieA);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].flowId).toBe(f2.id);
  });

  // ── Clearing ──────────────────────────────────────────────────────────────
  it('PUT { flowId: null } clears the targeted assignment', async () => {
    const f = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef() })).body;
    await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ scope: 'project', targetId: 'p1', flowId: f.id });

    const cleared = await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ scope: 'project', targetId: 'p1', flowId: null });
    expect(cleared.status).toBe(200);

    const list = await supertest(app).get('/v1/admin/flow-assignments').set('Cookie', cookieA);
    expect(list.body).toHaveLength(0);
  });

  // ── Backwards compat ──────────────────────────────────────────────────────
  it('legacy body { flowId } is treated as scope=org', async () => {
    const f = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef() })).body;
    const r = await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ flowId: f.id });
    expect(r.status).toBe(200);
    const list = await supertest(app).get('/v1/admin/flow-assignments').set('Cookie', cookieA);
    expect(list.body[0]).toMatchObject({ scope: 'org', targetId: '', flowId: f.id });
  });

  it('legacy body { flowId: null } clears the org assignment', async () => {
    const f = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef() })).body;
    await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA).send({ flowId: f.id });
    const cleared = await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA).send({ flowId: null });
    expect(cleared.status).toBe(200);
    const list = await supertest(app).get('/v1/admin/flow-assignments').set('Cookie', cookieA);
    expect(list.body).toHaveLength(0);
  });

  // ── Org isolation ─────────────────────────────────────────────────────────
  it('org A assignments invisible to org B', async () => {
    const f = (await supertest(app).post('/v1/admin/flows').set('Cookie', cookieA).send({ definition: sampleDef() })).body;
    await supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookieA)
      .send({ scope: 'project', targetId: 'p1', flowId: f.id });

    const listB = await supertest(app).get('/v1/admin/flow-assignments').set('Cookie', cookieB);
    expect(listB.body).toEqual([]);
  });
});
