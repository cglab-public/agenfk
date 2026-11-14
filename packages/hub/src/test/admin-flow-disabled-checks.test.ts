import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { loginAs } from './helpers/loginAs';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

/**
 * CGLAB-428 — a hub admin switches checks off on a step. The hub stores a
 * step's `disabledChecks` with the definition, keeps it across an update that
 * omits it (an older hub-ui), clears it on an empty list, and refuses what
 * core refuses: a human approval, or a check the step does not run.
 */
let __server: any;
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-flow-disabled-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};
const definition = (build: Record<string, unknown> = {}) => ({
  name: 'Org TDD',
  steps: [
    { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
    { id: 's1', name: 'specs', label: 'Specs', order: 1, role: 'test-authoring' },
    { id: 's2', name: 'build', label: 'Build', order: 2, role: 'coding', ...build },
    { id: 's3', name: 'done', label: 'Done', order: 3, isAnchor: true },
  ],
});

describe('hub admin flows with disabled checks', () => {
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

  const post = (def: any) => supertest(__server).post('/v1/admin/flows').set('Cookie', cookie).send({ definition: def });
  const build = async (id: string) => (await supertest(__server).get(`/v1/admin/flows/${id}`).set('Cookie', cookie)).body.definition.steps.find((s: any) => s.id === 's2');

  it('stores a step\'s disabledChecks with the definition', async () => {
    const r = await post(definition({ disabledChecks: ['suite-green'] }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await build(r.body.id)).disabledChecks).toEqual(['suite-green']);
  });

  it('keeps them across an update that omits them, and clears them on an empty list', async () => {
    const created = await post(definition({ disabledChecks: ['suite-green'] }));
    const put = (b: Record<string, unknown>) => supertest(__server).put(`/v1/admin/flows/${created.body.id}`).set('Cookie', cookie).send({ definition: definition(b) });
    expect((await put({})).status).toBe(200);
    expect((await build(created.body.id)).disabledChecks).toEqual(['suite-green']);
    expect((await put({ disabledChecks: [] })).status).toBe(200);
    expect(await build(created.body.id)).not.toHaveProperty('disabledChecks');
  });

  it('refuses switching off a human approval, or a check the step does not run', async () => {
    const approval = await post(definition({ checks: [{ id: 'human-approval' }], disabledChecks: ['human-approval'] }));
    expect(approval.status).toBe(400);
    expect(approval.body.error).toMatch(/human-approval/);
    const notRun = await post(definition({ disabledChecks: ['review-record'] }));
    expect(notRun.status).toBe(400);
    expect(notRun.body.error).toMatch(/review-record/);
  });
});
