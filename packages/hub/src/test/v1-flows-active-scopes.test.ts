import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-flows-active-scopes-${process.pid}.sqlite`);
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

describe('GET /v1/flows/active — multi-scope resolution', () => {
  let app: any;
  let ctx: any;
  let cookie: string;

  // Three api keys for the same org bound to different installations.
  let tokenInstall1: string;
  let tokenInstall2: string;
  let tokenNoInstall: string;

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
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    cookie = await loginAs(app, 'admin@x', 'longenough1');

    await ctx.db.run(
      "INSERT INTO installations (id, org_id, first_seen, last_seen) VALUES (?, ?, datetime('now'), datetime('now'))",
      ['install-1', 'org-a'],
    );
    await ctx.db.run(
      "INSERT INTO installations (id, org_id, first_seen, last_seen) VALUES (?, ?, datetime('now'), datetime('now'))",
      ['install-2', 'org-a'],
    );

    tokenInstall1 = await issueApiKey(ctx.db, 'org-a', 'i1', { installationId: 'install-1' });
    tokenInstall2 = await issueApiKey(ctx.db, 'org-a', 'i2', { installationId: 'install-2' });
    tokenNoInstall = await issueApiKey(ctx.db, 'org-a', 'no-install');
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  it('returns the org-default flow when no scope context is provided', async () => {
    const orgFlow = await seedFlow(app, cookie, 'Org Flow');
    await assign(app, cookie, 'org', null, orgFlow);

    const r = await supertest(app).get('/v1/flows/active').set('Authorization', `Bearer ${tokenNoInstall}`);
    expect(r.status).toBe(200);
    expect(r.body.flow.id).toBe(orgFlow);
    expect(r.body.scope).toBe('org');
    expect(r.body.targetId).toBe('');
  });

  it('returns project-override flow when projectId matches', async () => {
    const orgFlow = await seedFlow(app, cookie, 'Org Flow');
    const projFlow = await seedFlow(app, cookie, 'Project-1 Flow');
    await assign(app, cookie, 'org', null, orgFlow);
    await assign(app, cookie, 'project', 'project-1', projFlow);

    const matched = await supertest(app).get('/v1/flows/active?projectId=project-1').set('Authorization', `Bearer ${tokenNoInstall}`);
    expect(matched.body.flow.id).toBe(projFlow);
    expect(matched.body.scope).toBe('project');
    expect(matched.body.targetId).toBe('project-1');

    const unmatched = await supertest(app).get('/v1/flows/active?projectId=project-2').set('Authorization', `Bearer ${tokenNoInstall}`);
    expect(unmatched.body.flow.id).toBe(orgFlow);
    expect(unmatched.body.scope).toBe('org');
  });

  it('installation override beats project override', async () => {
    const orgFlow = await seedFlow(app, cookie, 'Org');
    const projFlow = await seedFlow(app, cookie, 'Proj');
    const instFlow = await seedFlow(app, cookie, 'Inst');
    await assign(app, cookie, 'org', null, orgFlow);
    await assign(app, cookie, 'project', 'project-1', projFlow);
    await assign(app, cookie, 'installation', 'install-1', instFlow);

    const r = await supertest(app).get('/v1/flows/active?projectId=project-1').set('Authorization', `Bearer ${tokenInstall1}`);
    expect(r.body.flow.id).toBe(instFlow);
    expect(r.body.scope).toBe('installation');
    expect(r.body.targetId).toBe('install-1');
  });

  it('falls back to project then org when installation has no override', async () => {
    const orgFlow = await seedFlow(app, cookie, 'Org');
    const projFlow = await seedFlow(app, cookie, 'Proj');
    await assign(app, cookie, 'org', null, orgFlow);
    await assign(app, cookie, 'project', 'project-1', projFlow);

    const r = await supertest(app).get('/v1/flows/active?projectId=project-1').set('Authorization', `Bearer ${tokenInstall2}`);
    expect(r.body.flow.id).toBe(projFlow);
    expect(r.body.scope).toBe('project');
  });

  it('ETag is keyed on (version, scope, targetId)', async () => {
    const orgFlow = await seedFlow(app, cookie, 'Org');
    const projFlow = await seedFlow(app, cookie, 'Proj');
    await assign(app, cookie, 'project', 'p1', projFlow);

    const first = await supertest(app).get('/v1/flows/active?projectId=p1').set('Authorization', `Bearer ${tokenNoInstall}`);
    const projEtag = first.headers.etag;
    expect(projEtag).toContain(':project:p1');

    // Same scope+version → 304
    const cached = await supertest(app).get('/v1/flows/active?projectId=p1')
      .set('Authorization', `Bearer ${tokenNoInstall}`).set('If-None-Match', projEtag);
    expect(cached.status).toBe(304);

    // Switch to org-fallback (no projectId) — different scope, different ETag
    await assign(app, cookie, 'org', null, orgFlow);
    const orgResp = await supertest(app).get('/v1/flows/active')
      .set('Authorization', `Bearer ${tokenNoInstall}`).set('If-None-Match', projEtag);
    expect(orgResp.status).toBe(200);
    expect(orgResp.headers.etag).toContain(':org:');
    expect(orgResp.body.flow.id).toBe(orgFlow);
  });

  it('returns { flow: null } when no matching assignment exists at any scope', async () => {
    const r = await supertest(app).get('/v1/flows/active?projectId=anything').set('Authorization', `Bearer ${tokenNoInstall}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ flow: null });
  });

  it('api_key with NULL installation_id resolves to org/project paths only', async () => {
    const orgFlow = await seedFlow(app, cookie, 'Org');
    const instFlow = await seedFlow(app, cookie, 'Inst');
    await assign(app, cookie, 'org', null, orgFlow);
    await assign(app, cookie, 'installation', 'install-1', instFlow);

    // tokenNoInstall has NULL installation_id — installation overrides should NOT match.
    const r = await supertest(app).get('/v1/flows/active').set('Authorization', `Bearer ${tokenNoInstall}`);
    expect(r.body.flow.id).toBe(orgFlow);
    expect(r.body.scope).toBe('org');
  });
});
