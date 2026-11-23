/**
 * Phase 1a of the Hub auto-join epic (INFRA-463): the join mode and the Entra
 * app role that gates automatic join, as the admin saves them. Kept apart from
 * jit-members.test.ts, which mocks jsonwebtoken and so cannot hold a session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';

let server: any;
let app: any;
let ctx: any;
const ROLE = 'AgEnFK.Member';
const TENANT = '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-joinmode-test-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

beforeEach(async () => {
  cleanup();
  const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' });
  app = out.app;
  if (server) await new Promise<void>(r => server.close(() => r()));
  server = app.listen(0);
  ctx = out.ctx;
});

afterEach(async () => {
  await drainApp(server);
  await ctx.db.close();
  cleanup();
});

describe('Join mode in the sign-in settings', () => {
  const put = async (body: any) => {
    await createPasswordUser(ctx.db, 'org', 'admin@acme.com', 'longenough1', 'admin');
    const cookie = await loginAs(app, 'admin@acme.com', 'longenough1');
    return { cookie, r: await supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie).send(body) };
  };

  it('starts off and round-trips auto with the required app role', async () => {
    const { cookie, r } = await put({ entraEnabled: true, entra: { tenantId: TENANT, requiredRole: ` ${ROLE} ` }, joinMode: 'auto' });
    expect(r.status).toBe(200);
    expect(r.body.joinMode).toBe('auto');
    expect(r.body.entra.requiredRole).toBe(ROLE);
    const get = await supertest(server).get('/v1/admin/auth-config').set('Cookie', cookie);
    expect(get.body.joinMode).toBe('auto');
    expect(get.body.entra.requiredRole).toBe(ROLE);
  });

  it('defaults to off', async () => {
    await createPasswordUser(ctx.db, 'org', 'admin@acme.com', 'longenough1', 'admin');
    const cookie = await loginAs(app, 'admin@acme.com', 'longenough1');
    const get = await supertest(server).get('/v1/admin/auth-config').set('Cookie', cookie);
    expect(get.body.joinMode).toBe('off');
  });

  it('refuses a join mode it does not know', async () => {
    const { r } = await put({ joinMode: 'everyone' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/join mode/i);
  });

  it('refuses automatic join with Entra on and no required app role, and stores nothing', async () => {
    const { r } = await put({ entraEnabled: true, entra: { tenantId: TENANT }, joinMode: 'auto' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/app role/i);
    const row = await ctx.db.get<any>("SELECT join_mode, entra_enabled FROM auth_config WHERE org_id = 'org'");
    expect(row.join_mode).toBe('off');
    expect(row.entra_enabled).toBe(0);
  });

  it('refuses an app role value with whitespace in it', async () => {
    const { r } = await put({ entra: { requiredRole: 'AgEnFK Member' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/app role/i);
  });

  it('audits a join mode change', async () => {
    const { r } = await put({ entraEnabled: true, entra: { tenantId: TENANT, requiredRole: ROLE }, joinMode: 'auto' });
    expect(r.status).toBe(200);
    const rows = await ctx.db.all<any>("SELECT before_json, after_json FROM config_audit WHERE action = 'auth-config.update'");
    expect(rows.some((a: any) => /"join_mode":"off"/.test(a.before_json) && /"join_mode":"auto"/.test(a.after_json))).toBe(true);
  });
});

describe('Automatic join keeps its app role across later saves', () => {
  const session = async () => {
    await createPasswordUser(ctx.db, 'org', 'admin@acme.com', 'longenough1', 'admin');
    const cookie = await loginAs(app, 'admin@acme.com', 'longenough1');
    return (body: any) => supertest(server).put('/v1/admin/auth-config').set('Cookie', cookie).send(body);
  };
  const stored = () => ctx.db.get<any>("SELECT join_mode, entra_enabled, entra_required_role FROM auth_config WHERE org_id = 'org'");

  it('refuses switching Entra on later while join mode is auto and no role is stored', async () => {
    const put = await session();
    expect((await put({ joinMode: 'auto' })).status).toBe(200);
    const r = await put({ entraEnabled: true, entra: { tenantId: TENANT } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/app role/i);
    expect(await stored()).toEqual({ join_mode: 'auto', entra_enabled: 0, entra_required_role: null });
  });

  it('refuses clearing the role later while join mode is auto and Entra is on', async () => {
    const put = await session();
    expect((await put({ entraEnabled: true, entra: { tenantId: TENANT, requiredRole: ROLE }, joinMode: 'auto' })).status).toBe(200);
    for (const requiredRole of [null, '', '   ']) {
      const r = await put({ entra: { requiredRole } });
      expect(r.status).toBe(400);
    }
    expect(await stored()).toEqual({ join_mode: 'auto', entra_enabled: 1, entra_required_role: ROLE });
  });

  it('refuses a role that is not text', async () => {
    const put = await session();
    for (const requiredRole of [42, ['x'], { value: ROLE }]) {
      const r = await put({ entra: { requiredRole } });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/app role/i);
    }
    expect((await stored()).entra_required_role).toBeNull();
  });
});
