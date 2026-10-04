/**
 * BUG 30c55937 (CGLAB-494) — the hub image runs Express 5, the tests ran 4.
 *
 * packages/hub asks for express ^4 and the lockfile nests 4.x under
 * packages/hub/node_modules, but the Docker runtime stage copies only the
 * repo-root node_modules, where express is 5.x. The config-audit route walker
 * read Express 4's `app._router`, found nothing on Express 5, and
 * installConfigAudit threw at boot: v2.0.0-beta.31 crash-looped in production
 * and ECS rolled back to beta.28.
 *
 * The hub now declares express ^5, so tests and image load the same one. This
 * file pins that, and that the audit installs and records on Express 5.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import supertest from 'supertest';

/** Resolves as the hub's own code does. */
const hubRequire = createRequire(path.resolve(__dirname, '../../package.json'));

import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { listAudit } from '../services/configAudit';
import { AUDITED_ROUTES, AUDIT_EXEMPT_ROUTES, mutatingRoutesOf, auditedRoutesOf } from '../services/configAuditRoutes';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-audit-express5-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); };

let server: any;
let app: any;
let ctx: any;

beforeEach(async () => {
  cleanup();
  const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' } as any);
  app = out.app;
  server = app.listen(0);
  ctx = out.ctx;
});
afterEach(async () => { await drainApp(server); await ctx?.db.close(); cleanup(); });

describe('the hub on Express 5 (what the image runs)', () => {
  it('the hub resolves Express 5, the one the image runs', () => {
    expect(hubRequire('express/package.json').version).toMatch(/^5\./);
    // The image copies only the root node_modules: a hub-local express would
    // be tested here and missing there.
    expect(fs.existsSync(path.resolve(__dirname, '../../node_modules/express'))).toBe(false);
    // An Express 5 app has no `_router`; that absence is what broke the walker.
    expect((app as any)._router).toBeUndefined();
    expect((app as any).router?.stack?.length).toBeGreaterThan(0);
  });

  it('boots, and every audited route carries its audit layer', () => {
    expect(auditedRoutesOf(app)).toEqual(AUDITED_ROUTES.map(r => `${r.method} ${r.path}`).sort());
  });

  it('sees every mutating route at its full mounted path, each audited or exempt', () => {
    const served = mutatingRoutesOf(app);
    expect(served.length).toBeGreaterThan(40);
    const known = new Set([...AUDITED_ROUTES.map(r => `${r.method} ${r.path}`), ...Object.keys(AUDIT_EXEMPT_ROUTES)]);
    expect(served.filter(r => !known.has(r))).toEqual([]);
    expect([...known].filter(r => !served.includes(r))).toEqual([]);
  });

  it('records a change made over HTTP', async () => {
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    const admin = await loginAs(server, 'admin@x', 'longenough1');
    const r = await supertest(server).put('/v1/admin/auth-config').set('Cookie', admin).send({ passwordEnabled: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = (await listAudit(ctx.db, 'org', { limit: 10 })).rows;
    expect(rows[0]).toMatchObject({ area: 'sign-in', action: 'auth-config.update', actorEmail: 'admin@x' });
  });
});
