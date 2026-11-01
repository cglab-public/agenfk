/**
 * CGLAB-702 S1: the admin CLI signs in with a device flow approved in the
 * browser by a signed-in admin, and gets a short-lived admin bearer token.
 *
 * The token is a second way to carry the SAME session the cookie carries:
 * it names a user, and whether that user may do anything, and as what, is
 * read from their row on every request - exactly as for the cookie. So a
 * demoted admin's CLI is a viewer at once, a deactivated one is out, and a
 * token can be revoked by its holder (logout) or by any admin.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';

let server: any;
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-admin-cli-auth-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

let app: any;
let ctx: any;
let adminCookie: string;
const idOf = async (email: string) => (await ctx.db.get('SELECT id FROM users WHERE email = ?', [email])).id as string;

beforeEach(async () => {
  cleanup();
  const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' });
  app = out.app;
  if (server) await new Promise<void>(r => server.close(() => r()));
  server = app.listen(0);
  ctx = out.ctx;
  await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
  await createPasswordUser(ctx.db, 'org', 'admin2@x', 'longenough1', 'admin');
  await createPasswordUser(ctx.db, 'org', 'view@x', 'longenough1', 'viewer');
  adminCookie = await loginAs(server, 'admin@x', 'longenough1');
});

afterEach(async () => {
  await drainApp(server);
  await ctx.db.close();
  cleanup();
});

const req = () => supertest(server);

/** Runs the whole device flow as `cookie`'s user and returns the poll's approved body. */
async function signInCli(cookie = adminCookie): Promise<any> {
  const start = await req().post('/hub/admin-device/start').send({});
  expect(start.status).toBe(200);
  const approve = await req().post('/hub/admin-device/approve').set('Cookie', cookie).send({ userCode: start.body.userCode });
  expect(approve.status).toBe(200);
  const poll = await req().post('/hub/admin-device/poll').send({ deviceCode: start.body.deviceCode });
  expect(poll.status).toBe(200);
  expect(poll.body.status).toBe('approved');
  return poll.body;
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('admin device flow', () => {
  it('start needs no auth and points the browser at the admin approval page', async () => {
    const r = await req().post('/hub/admin-device/start').send({});
    expect(r.status).toBe(200);
    expect(r.body.deviceCode.length).toBeGreaterThan(20);
    expect(r.body.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const uri = new URL(r.body.verificationUri);
    expect(uri.pathname).toBe('/connect');
    expect(uri.searchParams.get('code')).toBe(r.body.userCode);
    expect(uri.searchParams.get('kind')).toBe('admin');
    expect(r.body.interval).toBeGreaterThan(0);
    expect(r.body.expiresIn).toBeGreaterThan(0);
  });

  it('an admin code is not an installation code: the installation approve does not know it', async () => {
    const start = await req().post('/hub/admin-device/start').send({});
    const r = await req().post('/hub/device/approve').set('Cookie', adminCookie).send({ userCode: start.body.userCode });
    expect(r.status).toBe(404);
  });

  it('poll is pending until approved, and unknown codes are 404', async () => {
    const start = await req().post('/hub/admin-device/start').send({});
    const r = await req().post('/hub/admin-device/poll').send({ deviceCode: start.body.deviceCode });
    expect(r.body.status).toBe('pending');
    const unknown = await req().post('/hub/admin-device/poll').send({ deviceCode: 'nope' });
    expect(unknown.status).toBe(404);
  });

  it('approve needs a signed-in admin: none is 401, a viewer is 403', async () => {
    const start = await req().post('/hub/admin-device/start').send({});
    expect((await req().post('/hub/admin-device/approve').send({ userCode: start.body.userCode })).status).toBe(401);
    const viewer = await loginAs(server, 'view@x', 'longenough1');
    expect((await req().post('/hub/admin-device/approve').set('Cookie', viewer).send({ userCode: start.body.userCode })).status).toBe(403);
    const poll = await req().post('/hub/admin-device/poll').send({ deviceCode: start.body.deviceCode });
    expect(poll.body.status).toBe('pending');
  });

  it('the approved poll hands over a 12-hour token for the approving admin, exactly once', async () => {
    const start = await req().post('/hub/admin-device/start').send({});
    await req().post('/hub/admin-device/approve').set('Cookie', adminCookie).send({ userCode: start.body.userCode });
    const poll = await req().post('/hub/admin-device/poll').send({ deviceCode: start.body.deviceCode });
    expect(poll.body.status).toBe('approved');
    expect(poll.body.token).toMatch(/^agka_[0-9a-f]{64}$/);
    expect(poll.body.orgId).toBe('org');
    expect(poll.body.user).toEqual({ email: 'admin@x', role: 'admin' });
    expect(typeof poll.body.hubUrl).toBe('string');
    const hours = (new Date(poll.body.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);

    const again = await req().post('/hub/admin-device/poll').send({ deviceCode: start.body.deviceCode });
    expect(again.status).toBe(410);
  });

  it('a code cannot be approved twice', async () => {
    const start = await req().post('/hub/admin-device/start').send({});
    await req().post('/hub/admin-device/approve').set('Cookie', adminCookie).send({ userCode: start.body.userCode });
    const r = await req().post('/hub/admin-device/approve').set('Cookie', adminCookie).send({ userCode: start.body.userCode });
    expect(r.status).toBe(409);
  });

  it('the token is never stored in plain form', async () => {
    const { token } = await signInCli();
    const rows = await ctx.db.all('SELECT * FROM admin_cli_tokens');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('a CLI token cannot approve another CLI sign-in (no self-renewal past 12 hours)', async () => {
    const { token } = await signInCli();
    const start = await req().post('/hub/admin-device/start').send({});
    const r = await req().post('/hub/admin-device/approve').set(bearer(token)).send({ userCode: start.body.userCode });
    expect(r.status).toBe(403);
  });
});

describe('collecting the grant (review fixes)', () => {
  it('any hub process can answer the poll: approve on one, collect on another sharing the database', async () => {
    const other = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' });
    const otherServer = other.app.listen(0);
    try {
      const start = await req().post('/hub/admin-device/start').send({});
      await req().post('/hub/admin-device/approve').set('Cookie', adminCookie).send({ userCode: start.body.userCode });
      const poll = await supertest(otherServer).post('/hub/admin-device/poll').send({ deviceCode: start.body.deviceCode });
      expect(poll.status).toBe(200);
      expect(poll.body.status).toBe('approved');
      expect((await req().get('/auth/me').set(bearer(poll.body.token))).status).toBe(200);
    } finally {
      await drainApp(otherServer);
      await other.ctx.db.close();
    }
  });

  it('two polls racing for one grant: exactly one gets a token', async () => {
    const start = await req().post('/hub/admin-device/start').send({});
    await req().post('/hub/admin-device/approve').set('Cookie', adminCookie).send({ userCode: start.body.userCode });
    // Hold each poll at its read of the grant until both have read it, so both
    // see it unclaimed: only the atomic claim can then keep the second out.
    const realGet = ctx.db.get.bind(ctx.db);
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>(r => { release = r; });
    ctx.db.get = async (sql: string, params?: unknown[]) => {
      const row = await realGet(sql, params);
      if (sql.includes('consumed_at, expires_at FROM admin_device_codes')) {
        if (++arrived === 2) release();
        await bothRead;
      }
      return row;
    };
    try {
      const polls = await Promise.all([1, 2].map(() => req().post('/hub/admin-device/poll').send({ deviceCode: start.body.deviceCode })));
      expect(arrived).toBe(2);
      expect(polls.filter(p => p.body.status === 'approved')).toHaveLength(1);
      expect(polls.filter(p => p.status === 410)).toHaveLength(1);
    } finally {
      ctx.db.get = realGet;
    }
    expect(await ctx.db.all('SELECT id FROM admin_cli_tokens')).toHaveLength(1);
  });

  it('a failed issue leaves the grant collectable, and a grant never yields two tokens', async () => {
    const start = await req().post('/hub/admin-device/start').send({});
    await req().post('/hub/admin-device/approve').set('Cookie', adminCookie).send({ userCode: start.body.userCode });
    const realRun = ctx.db.run.bind(ctx.db);
    let failNext = true;
    ctx.db.run = async (sql: string, params?: unknown[]) => {
      if (failNext && sql.startsWith('INSERT INTO admin_cli_tokens')) { failNext = false; throw new Error('db outage'); }
      return realRun(sql, params);
    };
    try {
      const failed = await req().post('/hub/admin-device/poll').send({ deviceCode: start.body.deviceCode });
      expect(failed.status).toBe(500);
      const ok = await req().post('/hub/admin-device/poll').send({ deviceCode: start.body.deviceCode });
      expect(ok.body.status).toBe('approved');
    } finally {
      ctx.db.run = realRun;
    }
    expect(await ctx.db.all('SELECT id FROM admin_cli_tokens')).toHaveLength(1);
    // Even forced, the database refuses a second token for the same grant.
    await ctx.db.run('UPDATE admin_device_codes SET consumed_at = NULL');
    const again = await req().post('/hub/admin-device/poll').send({ deviceCode: start.body.deviceCode });
    expect(again.body.status).not.toBe('approved');
    expect(await ctx.db.all('SELECT id FROM admin_cli_tokens')).toHaveLength(1);
  });

  it('an approver demoted before the CLI collects gets no token', async () => {
    const start = await req().post('/hub/admin-device/start').send({});
    await req().post('/hub/admin-device/approve').set('Cookie', adminCookie).send({ userCode: start.body.userCode });
    await ctx.db.run("UPDATE users SET role = 'viewer' WHERE email = 'admin@x'");
    const poll = await req().post('/hub/admin-device/poll').send({ deviceCode: start.body.deviceCode });
    expect(poll.status).toBe(403);
    expect(await ctx.db.all('SELECT id FROM admin_cli_tokens')).toHaveLength(0);
  });

  it('renaming the org with the CLI token hands out no board cookie, and the token keeps working', async () => {
    const { token } = await signInCli();
    const r = await req().post('/v1/admin/orgs/rename').set(bearer(token)).send({ from: 'org', to: 'renamed-org' });
    expect(r.status).toBe(200);
    expect(r.headers['set-cookie']).toBeUndefined();
    const me = await req().get('/auth/me').set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body.orgId).toBe('renamed-org');
  });
});

describe('the admin bearer token', () => {
  it('opens admin routes and /auth/me as the approving admin', async () => {
    const { token } = await signInCli();
    expect((await req().get('/v1/admin/users').set(bearer(token))).status).toBe(200);
    const me = await req().get('/auth/me').set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('admin@x');
    expect(me.body.role).toBe('admin');
  });

  it('an installation API key is not an admin credential', async () => {
    const key = await issueApiKey(ctx.db, 'org', 'test');
    expect((await req().get('/v1/admin/users').set(bearer(key))).status).toBe(401);
  });

  it('a made-up token is refused', async () => {
    expect((await req().get('/v1/admin/users').set(bearer('agka_' + '0'.repeat(64)))).status).toBe(401);
    expect((await req().get('/v1/admin/users').set(bearer('garbage'))).status).toBe(401);
  });

  it('a demoted admin\'s token loses admin at once; a deactivated one\'s is refused', async () => {
    const { token } = await signInCli(await loginAs(server, 'admin2@x', 'longenough1'));
    await req().put(`/v1/admin/users/${await idOf('admin2@x')}`).set('Cookie', adminCookie).send({ role: 'viewer' });
    expect((await req().get('/v1/admin/users').set(bearer(token))).status).toBe(403);
    await ctx.db.run('UPDATE users SET active = 0 WHERE email = ?', ['admin2@x']);
    expect((await req().get('/auth/me').set(bearer(token))).status).toBe(401);
  });

  it('an expired token is refused', async () => {
    const { token } = await signInCli();
    await ctx.db.run('UPDATE admin_cli_tokens SET expires_at = ?', [new Date(Date.now() - 1000).toISOString()]);
    expect((await req().get('/v1/admin/users').set(bearer(token))).status).toBe(401);
  });

  it('logout with the token revokes it', async () => {
    const { token } = await signInCli();
    const out = await req().post('/auth/logout').set(bearer(token));
    expect(out.status).toBe(200);
    expect((await req().get('/v1/admin/users').set(bearer(token))).status).toBe(401);
  });

  it('a change made with the token is audited as the admin, from the CLI', async () => {
    const { token } = await signInCli();
    const r = await req().put(`/v1/admin/users/${await idOf('view@x')}`).set(bearer(token)).send({ role: 'admin' });
    expect(r.status).toBe(200);
    const audit = await req().get('/v1/admin/audit').set('Cookie', adminCookie);
    const viewId = await idOf('view@x');
    const row = audit.body.rows.find((x: any) => x.action === 'user.update' && x.target?.includes(viewId));
    expect(row).toBeTruthy();
    expect(row.source).toBe('cli');
    expect(row.actorEmail).toBe('admin@x');
  });

  it('approving a CLI sign-in is itself audited', async () => {
    await signInCli();
    const audit = await req().get('/v1/admin/audit').set('Cookie', adminCookie);
    expect(audit.body.rows.some((x: any) => x.action === 'admin-cli.approve' && x.actorEmail === 'admin@x')).toBe(true);
  });
});

describe('admins manage CLI sessions', () => {
  it('lists live sessions without their secrets, and revokes one', async () => {
    const { token } = await signInCli();
    const list = await req().get('/v1/admin/cli-sessions').set('Cookie', adminCookie);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    const s = list.body[0];
    expect(s.userEmail).toBe('admin@x');
    expect(typeof s.id).toBe('string');
    expect(typeof s.expiresAt).toBe('string');
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(s).not.toHaveProperty('tokenHash');

    const del = await req().delete(`/v1/admin/cli-sessions/${s.id}`).set('Cookie', adminCookie);
    expect(del.status).toBe(200);
    expect((await req().get('/v1/admin/users').set(bearer(token))).status).toBe(401);
    expect((await req().get('/v1/admin/cli-sessions').set('Cookie', adminCookie)).body).toHaveLength(0);
  });

  it('a viewer cannot list sessions', async () => {
    const viewer = await loginAs(server, 'view@x', 'longenough1');
    expect((await req().get('/v1/admin/cli-sessions').set('Cookie', viewer)).status).toBe(403);
  });

  it('revoking an unknown session is 404', async () => {
    expect((await req().delete('/v1/admin/cli-sessions/nope').set('Cookie', adminCookie)).status).toBe(404);
  });
});
