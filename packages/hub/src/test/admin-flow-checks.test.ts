import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { loginAs } from './helpers/loginAs';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';
import { invalidFlowDefinition } from '../services/flowDefinition';

/**
 * CGLAB-380 (S4-T1) — a flow an org admin pushes carries step roles and checks,
 * and the hub validates them exactly as a local server would: an org-wide push
 * that names an unknown check, or a check with no earlier producer for its
 * record, would otherwise reach every installation in the org.
 */
let __server: any;
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-flow-checks-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const definition = (steps?: any[]) => ({
  name: 'Org TDD',
  steps: steps ?? [
    { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
    { id: 's1', name: 'specs', label: 'Specs', order: 1, role: 'test-authoring' },
    { id: 's2', name: 'build', label: 'Build', order: 2, role: 'coding', checks: [{ id: 'jira-key-valid' }] },
    { id: 's3', name: 'done', label: 'Done', order: 3, isAnchor: true },
  ],
});
const orphan = () => definition([
  { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
  { id: 's1', name: 'build', label: 'Build', order: 1, role: 'coding', checks: [{ id: 'red-set-passes-by-name' }] },
  { id: 's2', name: 'done', label: 'Done', order: 2, isAnchor: true },
]);

describe('invalidFlowDefinition with step contracts', () => {
  it('accepts roles and known checks', () => {
    expect(invalidFlowDefinition(definition())).toBeNull();
  });
  it('refuses a check with no earlier producer, naming it', () => {
    expect(invalidFlowDefinition(orphan())).toMatch(/red-set-passes-by-name.*redSet|redSet.*red-set-passes-by-name/s);
  });
  it('refuses an unknown check id', () => {
    const d = definition();
    d.steps[2].checks = [{ id: 'nope' }];
    expect(invalidFlowDefinition(d)).toMatch(/nope/);
  });
});

describe('admin flow routes with step contracts', () => {
  let app: any;
  let ctx: any;
  let cookie: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org-a' });
    app = out.app;
    ctx = out.ctx;
    if (__server) await new Promise<void>(r => __server.close(() => r()));
    __server = app.listen(0);
    await createPasswordUser(ctx.db, 'org-a', 'admin-a@x', 'longenough1', 'admin');
    cookie = await loginAs(app, 'admin-a@x', 'longenough1');
  });
  afterEach(async () => {
    await drainApp(__server);
    await ctx.db.close();
    cleanup();
  });

  it('POST refuses an invalid contract with 400', async () => {
    const r = await supertest(__server).post('/v1/admin/flows').set('Cookie', cookie).send({ definition: orphan() });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/redSet/);
  });

  it('PUT that omits role/checks keeps the stored ones (an older hub-ui never wipes them)', async () => {
    const created = await supertest(__server).post('/v1/admin/flows').set('Cookie', cookie).send({ definition: definition() });
    expect(created.status).toBe(201);
    const stripped = definition().steps.map(({ role, checks, ...rest }: any) => rest);
    const r = await supertest(__server).put(`/v1/admin/flows/${created.body.id}`).set('Cookie', cookie).send({ definition: { name: 'Org TDD', steps: stripped } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const got = await supertest(__server).get(`/v1/admin/flows/${created.body.id}`).set('Cookie', cookie);
    const build = got.body.definition.steps.find((s: any) => s.id === 's2');
    expect(build.role).toBe('coding');
    expect(build.checks).toEqual([{ id: 'jira-key-valid' }]);
  });
});
