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
 * CGLAB-384 (S8-T1) — the hub serves the flow editor what a draft's steps
 * mean (POST /v1/admin/flows/contract), computed with the same core functions
 * it validates org flows with. Admin-only, like the rest of the flow routes.
 */
let __server: any;
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-flow-contract-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};
const steps = [
  { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
  { id: 's1', name: 'build', label: 'Build', order: 1, role: 'coding', checks: [{ id: 'red-set-passes-by-name' }] },
  { id: 's2', name: 'done', label: 'Done', order: 2, isAnchor: true },
];

describe('POST /v1/admin/flows/contract', () => {
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
    await createPasswordUser(ctx.db, 'org-a', 'viewer-a@x', 'longenough1', 'viewer');
    cookie = await loginAs(app, 'admin-a@x', 'longenough1');
  });
  afterEach(async () => {
    if (__server) { await new Promise<void>(r => __server.close(() => r())); __server = null; }
    await drainApp(app);
    ctx?.db?.close?.();
    cleanup();
  });

  it("returns the draft's contract, with the error a save would be refused with", async () => {
    const res = await supertest(__server).post('/v1/admin/flows/contract').set('Cookie', cookie).send({ steps });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.join(' ')).toMatch(/red-set-passes-by-name/);
    expect(res.body.steps[1]).toMatchObject({ name: 'build', role: 'coding' });
    expect(res.body.catalogue.length).toBeGreaterThan(10);
  });

  it('refuses a caller that is not signed in', async () => {
    expect((await supertest(__server).post('/v1/admin/flows/contract').send({ steps })).status).toBe(401);
  });
});
