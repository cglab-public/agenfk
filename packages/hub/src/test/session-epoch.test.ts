/**
 * Security audit, Fix 1 (AEF-5): a password change must revoke live sessions.
 *
 * A session is a signed JWT with a 12h TTL. requireSession already re-reads the
 * user row per request, so a demoted or deleted user is cut off at once - but
 * nothing tied the cookie to the CREDENTIAL, so after "reset the password of the
 * compromised account" the attacker's cookie kept working for up to 12 hours.
 * `users.session_epoch` is that tie: the cookie carries the epoch it was issued
 * under, requireSession refuses a mismatch, and a password change bumps it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { signSession, verifySession, SESSION_COOKIE } from '../auth/session';
import { completeSsoLogin } from '../auth/oauth';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-session-epoch-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); };
const SESSION_SECRET = 'test-session-secret';
const BASE = { dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: SESSION_SECRET, defaultOrgId: 'org' };

let server: any = null;
let ctx: any = null;
let logged: string[] = [];

/** Boot the hub (again) on the same database, capturing what it logs. */
async function boot(extra: Record<string, unknown> = {}) {
  if (server) { await drainApp(server); server = null; }
  if (ctx) { await ctx.db.close(); ctx = null; }
  logged = [];
  const capture = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  const log = vi.spyOn(console, 'log').mockImplementation(capture);
  const warn = vi.spyOn(console, 'warn').mockImplementation(capture);
  const out = await createHubApp({ ...BASE, ...extra } as any);
  log.mockRestore(); warn.mockRestore();
  server = out.app.listen(0);
  ctx = out.ctx;
}

const me = (cookie: string) => supertest(server).get('/auth/me').set('Cookie', cookie);
const userId = async (email: string): Promise<string> => (await ctx.db.get('SELECT id FROM users WHERE email = ?', [email])).id;
const epochOf = async (email: string): Promise<number> => Number((await ctx.db.get('SELECT session_epoch FROM users WHERE email = ?', [email])).session_epoch);
const adminPut = (cookie: string, id: string, body: Record<string, unknown>) =>
  supertest(server).put(`/v1/admin/users/${id}`).set('Cookie', cookie).send(body);
const cookieFor = (token: string) => `${SESSION_COOKIE}=${token}`;

beforeEach(async () => {
  cleanup();
  await boot();
  await createPasswordUser(ctx.db, 'org', 'admin@x', 'admin-password-1', 'admin');
  await createPasswordUser(ctx.db, 'org', 'victim@x', 'old-password-1', 'viewer');
});
afterEach(async () => {
  if (server) await drainApp(server);
  if (ctx) await ctx.db.close();
  server = null; ctx = null;
  cleanup();
});

describe('admin password reset revokes live sessions', () => {
  it('the old cookie is refused after the reset, and the new password signs in', async () => {
    const stolen = await loginAs(server, 'victim@x', 'old-password-1');
    expect((await me(stolen)).status).toBe(200);

    const adminCookie = await loginAs(server, 'admin@x', 'admin-password-1');
    const r = await adminPut(adminCookie, await userId('victim@x'), { password: 'new-password-1' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    expect((await me(stolen)).status).toBe(401);
    expect((await supertest(server).post('/auth/login').send({ email: 'victim@x', password: 'old-password-1' })).status).toBe(401);
    const fresh = await supertest(server).post('/auth/login').send({ email: 'victim@x', password: 'new-password-1' });
    expect(fresh.status).toBe(200);
    expect((await me(fresh.headers['set-cookie'][0])).status).toBe(200);
  });

  it('a body without a usable password leaves sessions alone (no over-revocation)', async () => {
    const victim = await loginAs(server, 'victim@x', 'old-password-1');
    const adminCookie = await loginAs(server, 'admin@x', 'admin-password-1');
    const id = await userId('victim@x');

    expect((await adminPut(adminCookie, id, { role: 'viewer' })).status).toBe(200);
    // Under the 8-char floor the route ignores the password, so nothing rotated.
    expect((await adminPut(adminCookie, id, { role: 'viewer', password: 'short' })).status).toBe(200);

    expect(await epochOf('victim@x')).toBe(0);
    expect((await me(victim)).status).toBe(200);
  });

  it('the admin\'s own session survives resetting someone else', async () => {
    const adminCookie = await loginAs(server, 'admin@x', 'admin-password-1');
    await adminPut(adminCookie, await userId('victim@x'), { password: 'new-password-1' });
    expect((await me(adminCookie)).status).toBe(200);
  });
});

describe('admin recovery redemption revokes live sessions', () => {
  it('redeeming a token invalidates the admin\'s earlier sessions, and signs in a valid one', async () => {
    const before = await loginAs(server, 'admin@x', 'admin-password-1');
    await boot({ resetAdminEmail: 'admin@x' });
    // A restart is not a credential change: the earlier session still works.
    expect((await me(before)).status).toBe(200);
    const token = logged.find(l => /admin recovery/i.test(l))?.match(/([A-Za-z0-9_-]{40,})/)?.[1];
    expect(token, logged.join('\n')).toBeTruthy();

    const r = await supertest(server).post('/auth/recover').send({ token, password: 'recovered-password-1' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    expect((await me(before)).status).toBe(401);
    expect((await me(r.headers['set-cookie'][0])).status).toBe(200);
  });
});

describe('what was already enforced still is', () => {
  it('a demoted admin keeps no admin access on the old cookie', async () => {
    await createPasswordUser(ctx.db, 'org', 'admin2@x', 'admin-password-2', 'admin');
    const doomed = await loginAs(server, 'admin2@x', 'admin-password-2');
    expect((await supertest(server).get('/v1/admin/users').set('Cookie', doomed)).status).toBe(200);

    const adminCookie = await loginAs(server, 'admin@x', 'admin-password-1');
    expect((await adminPut(adminCookie, await userId('admin2@x'), { role: 'viewer' })).status).toBe(200);

    expect((await supertest(server).get('/v1/admin/users').set('Cookie', doomed)).status).toBe(403);
  });

  it('a deactivated user\'s old cookie is refused', async () => {
    const victim = await loginAs(server, 'victim@x', 'old-password-1');
    const adminCookie = await loginAs(server, 'admin@x', 'admin-password-1');
    expect((await adminPut(adminCookie, await userId('victim@x'), { active: false })).status).toBe(200);
    expect((await me(victim)).status).toBe(401);
  });

  it('re-activating an account does not revive the cookies refused while it was off', async () => {
    const victim = await loginAs(server, 'victim@x', 'old-password-1');
    const adminCookie = await loginAs(server, 'admin@x', 'admin-password-1');
    const id = await userId('victim@x');
    await adminPut(adminCookie, id, { active: false });
    expect((await adminPut(adminCookie, id, { active: true })).status).toBe(200);
    expect((await me(victim)).status).toBe(401);
    expect((await loginAs(server, 'victim@x', 'old-password-1')).length).toBeGreaterThan(0);
  });
});

describe('the epoch claim', () => {
  it('a JWT with no epoch claim is epoch 0: refused once a user is at epoch 1', async () => {
    const id = await userId('victim@x');
    const legacy = signSession({ userId: id, orgId: 'org', role: 'viewer' }, SESSION_SECRET);
    expect((await me(cookieFor(legacy))).status).toBe(200);   // a fresh user is at epoch 0
    await ctx.db.run('UPDATE users SET session_epoch = 1 WHERE id = ?', [id]);
    expect((await me(cookieFor(legacy))).status).toBe(401);
  });

  it('a cookie from login carries the row\'s epoch', async () => {
    await ctx.db.run('UPDATE users SET session_epoch = 4 WHERE email = ?', ['victim@x']);
    const c = await loginAs(server, 'victim@x', 'old-password-1');
    const payload = verifySession(c.split(';')[0].split('=')[1], SESSION_SECRET);
    expect(payload?.epoch).toBe(4);
  });

  it('SSO sign-in stamps the row\'s epoch on the cookie', async () => {
    await ctx.db.run('UPDATE users SET session_epoch = 7 WHERE email = ?', ['victim@x']);
    const row = await ctx.db.get('SELECT * FROM users WHERE email = ?', ['victim@x']);
    let value = '';
    const res = { cookie: (_n: string, v: string) => { value = v; }, req: {} } as any;
    await completeSsoLogin(ctx.db, res, row, SESSION_SECRET);
    expect(verifySession(value, SESSION_SECRET)?.epoch).toBe(7);
  });

  it('the org-rename re-issued cookie keeps the caller signed in', async () => {
    await ctx.db.run('UPDATE users SET session_epoch = 3 WHERE email = ?', ['admin@x']);
    const adminCookie = await loginAs(server, 'admin@x', 'admin-password-1');
    const r = await supertest(server).post('/v1/admin/orgs/rename').set('Cookie', adminCookie).send({ from: 'org', to: 'renamed' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await me(r.headers['set-cookie'][0])).status).toBe(200);
  });
});

describe('migration of a hub that predates session_epoch', () => {
  /** Strip the column, as an older hub's database would lack it. */
  async function downgradeToPreEpochSchema() {
    await drainApp(server); server = null;
    await ctx.db.close(); ctx = null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const raw = new DatabaseSync(TEST_DB);
    raw.exec('ALTER TABLE users DROP COLUMN session_epoch');
    raw.close();
  }

  it('invalidates every pre-existing JWT exactly once', async () => {
    const id = await userId('victim@x');
    // What the old hub signed: no epoch claim at all.
    const preMigration = cookieFor(signSession({ userId: id, orgId: 'org', role: 'viewer' }, SESSION_SECRET));
    await downgradeToPreEpochSchema();

    await boot();
    expect(await epochOf('victim@x')).toBe(1);
    expect((await me(preMigration)).status).toBe(401);

    // Users sign in again, and that session survives the NEXT restart: the
    // bump must not repeat on every boot or each deploy would log everyone out.
    const relogin = await loginAs(server, 'victim@x', 'old-password-1');
    expect((await me(relogin)).status).toBe(200);
    await boot();
    expect(await epochOf('victim@x')).toBe(1);
    expect((await me(relogin)).status).toBe(200);
  });

  it('never lowers or resets an epoch a password change has advanced', async () => {
    // A migration that re-ran "SET session_epoch = 1" each boot would pass the
    // test above (the epoch is already 1) while reviving every cookie that a
    // later reset had revoked.
    await ctx.db.run('UPDATE users SET session_epoch = 2 WHERE email = ?', ['victim@x']);
    await boot();
    expect(await epochOf('victim@x')).toBe(2);
  });
});
