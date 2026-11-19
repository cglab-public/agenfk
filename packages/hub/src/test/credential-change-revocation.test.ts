/** What a credential change leaves signed in, and what an overloaded hash pool gives away about an email (PR #267 review). */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueAdminCliToken } from '../auth/adminCliToken';
import { mintAdminRecoveryToken } from '../auth/adminRecovery';
import * as livePool from '../auth/bcryptPool';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-credential-change-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); };

let server: any = null;
let ctx: any = null;

const login = (email: string, password: string) => supertest(server).post('/auth/login').send({ email, password });
const sessionCookie = (r: { headers: Record<string, any> }): string | undefined =>
  (r.headers['set-cookie'] as string[] | undefined)?.find(c => c.startsWith('agenfk_hub_session='));
const me = (cookie: string) => supertest(server).get('/auth/me').set('Cookie', cookie);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const meCli = (token: string) => supertest(server).get('/auth/me').set(bearer(token));
const userId = async (email: string): Promise<string> => (await ctx.db.get('SELECT id FROM users WHERE email = ?', [email])).id;

async function signedIn(email: string, role: 'admin' | 'viewer' = 'admin') {
  await createPasswordUser(ctx.db, 'org', email, 'longenough1', role);
  const cookie = sessionCookie(await login(email, 'longenough1'))!;
  return { id: await userId(email), cookie };
}
let grants = 0;
const cliToken = async (id: string): Promise<string> => (await issueAdminCliToken(ctx.db, 'org', id, `grant-${++grants}`)).token;
const setPassword = (id: string, password = 'brand-new-pass-1') => supertest(server).put(`/v1/admin/users/${id}`).send({ password });

beforeEach(async () => {
  cleanup();
  const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' } as any);
  server = out.app.listen(0);
  ctx = out.ctx;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await drainApp(server);
  if (ctx) await ctx.db.close();
  server = null; ctx = null;
  cleanup();
});
afterAll(async () => { await livePool.shutdownBcryptPool(); });

describe('an admin setting their OWN password (PUT /v1/admin/users/:id)', () => {
  it('stays signed in on this session: the reply carries a new cookie, and it works', async () => {
    const admin = await signedIn('admin@x');
    const r = await setPassword(admin.id).set('Cookie', admin.cookie);
    expect(r.status).toBe(200);
    const fresh = sessionCookie(r);
    expect(fresh, 'a new session cookie on the reply').toBeTruthy();
    expect((await me(fresh!)).status).toBe(200);
  });

  it('still ends every other session of theirs, and the cookie it replaced', async () => {
    const admin = await signedIn('admin@x');
    const elsewhere = sessionCookie(await login('admin@x', 'longenough1'))!;
    const r = await setPassword(admin.id).set('Cookie', admin.cookie);
    expect(sessionCookie(r)).toBeTruthy();
    expect((await me(elsewhere)).status).toBe(401);
    expect((await me(admin.cookie)).status).toBe(401);
  });

  it('through the admin CLI: no board cookie is handed out, the token in use keeps working and their other tokens are revoked', async () => {
    const admin = await signedIn('admin@x');
    const inUse = await cliToken(admin.id);
    const other = await cliToken(admin.id);
    const r = await setPassword(admin.id).set(bearer(inUse));
    expect(r.status).toBe(200);
    expect(sessionCookie(r)).toBeUndefined();
    expect((await meCli(inUse)).status).toBe(200);
    expect((await meCli(other)).status).toBe(401);
    expect((await me(admin.cookie)).status).toBe(401);
  });
});

describe("an admin setting SOMEONE ELSE's password", () => {
  it('sets no cookie, and the acting admin stays signed in', async () => {
    const admin = await signedIn('admin@x');
    const victim = await signedIn('victim@x', 'viewer');
    const r = await setPassword(victim.id).set('Cookie', admin.cookie);
    expect(r.status).toBe(200);
    expect(sessionCookie(r)).toBeUndefined();
    expect((await me(admin.cookie)).status).toBe(200);
    expect((await me(victim.cookie)).status).toBe(401);
  });

  it("revokes that user's admin CLI tokens, and nobody else's", async () => {
    const admin = await signedIn('admin@x');
    const other = await signedIn('admin2@x');
    const stolen = await cliToken(other.id);
    const mine = await cliToken(admin.id);
    expect((await meCli(stolen)).status).toBe(200);

    expect((await setPassword(other.id).set('Cookie', admin.cookie)).status).toBe(200);

    expect((await meCli(stolen)).status).toBe(401);
    expect((await meCli(mine)).status).toBe(200);
  });
});

describe('an admin CLI sign-in approved but not yet collected', () => {
  // Approved with a stolen cookie and left waiting: collecting it after the reset would mint a fresh 12-hour token.
  const approvedGrant = async (cookie: string): Promise<string> => {
    const start = await supertest(server).post('/hub/admin-device/start').send({});
    expect((await supertest(server).post('/hub/admin-device/approve').set('Cookie', cookie).send({ userCode: start.body.userCode })).status).toBe(200);
    return start.body.deviceCode;
  };
  const collect = (deviceCode: string) => supertest(server).post('/hub/admin-device/poll').send({ deviceCode });

  it("is void once the approver's password is reset: the poll hands out no token", async () => {
    const admin = await signedIn('admin@x');
    const other = await signedIn('admin2@x');
    const stolen = await approvedGrant(other.cookie);
    const mine = await approvedGrant(admin.cookie);

    expect((await setPassword(other.id).set('Cookie', admin.cookie)).status).toBe(200);

    expect((await collect(stolen)).body.token).toBeUndefined();
    expect((await collect(mine)).body.token, "the acting admin's own grant is untouched").toMatch(/^agka_/);
  });

  it('is void after the approver changes their own password, and after a recovery', async () => {
    const admin = await signedIn('admin@x');
    const beforeChange = await approvedGrant(admin.cookie);
    const changed = await setPassword(admin.id).set('Cookie', admin.cookie);
    expect((await collect(beforeChange)).body.token).toBeUndefined();

    const beforeRecovery = await approvedGrant(sessionCookie(changed)!);
    const minted = await mintAdminRecoveryToken(ctx.db, 'org', 'admin@x');
    expect((await supertest(server).post('/auth/recover').send({ token: (minted as { token: string }).token, password: 'a-new-password-1' })).status).toBe(200);
    expect((await collect(beforeRecovery)).body.token).toBeUndefined();
  });
});

describe('admin recovery (POST /auth/recover)', () => {
  const recover = (token: string) => supertest(server).post('/auth/recover').send({ token, password: 'a-new-password-1' });
  const mint = async (email: string): Promise<string> => {
    const out = await mintAdminRecoveryToken(ctx.db, 'org', email);
    if (!('token' in out)) throw new Error(out.refused);
    return out.token;
  };

  it("revokes the admin's CLI tokens along with their sessions", async () => {
    const admin = await signedIn('admin@x');
    const stolen = await cliToken(admin.id);
    const r = await recover(await mint('admin@x'));
    expect(r.status).toBe(200);
    expect((await meCli(stolen)).status).toBe(401);
    expect((await me(admin.cookie)).status).toBe(401);
    expect((await me(sessionCookie(r)!)).status).toBe(200);
  });

  it('signs the epoch its own transaction wrote: a reset committing right after it still ends the recovery session', async () => {
    const admin = await signedIn('admin@x');
    const token = await mint('admin@x');
    const realTransaction = ctx.db.transaction.bind(ctx.db);
    // The reset lands between recovery's commit and whatever recovery does next.
    vi.spyOn(ctx.db, 'transaction').mockImplementationOnce(async (fn: any) => {
      const out = await realTransaction(fn);
      await ctx.db.run('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?', [admin.id]);
      return out;
    });
    const r = await recover(token);
    expect(r.status).toBe(200);
    expect((await me(sessionCookie(r)!)).status).toBe(401);
  });
});

describe('POST /auth/login when the hash pool cannot take the check', () => {
  const failures: Array<[string, () => Error, number]> = [
    ['unavailable (503)', () => new livePool.PoolUnavailableError(), 503],
    ['saturated (429)', () => Object.assign(new Error('Too many sign-in attempts are being checked right now; try again shortly.'), { status: 429 }), 429],
  ];

  it.each(failures)('%s: a known email and an unknown, password-less, deactivated or SSO one all get the same answer', async (_name, makeError, status) => {
    await createPasswordUser(ctx.db, 'org', 'known@x', 'correct-horse-1', 'viewer');
    await createPasswordUser(ctx.db, 'org', 'inactive@x', 'correct-horse-1', 'viewer');
    await ctx.db.run('UPDATE users SET active = 0 WHERE email = ?', ['inactive@x']);
    await ctx.db.run('INSERT INTO users (id, org_id, email, password_hash, provider, role) VALUES (?, ?, ?, NULL, ?, ?)', ['u-invited', 'org', 'invited@x', 'password', 'viewer']);
    await createPasswordUser(ctx.db, 'org', 'sso@x', 'correct-horse-1', 'viewer');
    await ctx.db.run("UPDATE users SET provider = 'google', provider_subject = 'g-1' WHERE email = ?", ['sso@x']);

    vi.spyOn(livePool, 'bcryptCompare').mockImplementation(() => Promise.reject(makeError()));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const answers = [];
    for (const email of ['known@x', 'nobody@x', 'invited@x', 'inactive@x', 'sso@x']) {
      const r = await login(email, 'correct-horse-1');
      answers.push({ email, status: r.status, body: r.body, retryAfter: r.headers['retry-after'] });
    }
    expect(answers.map(a => a.status), JSON.stringify(answers)).toEqual([status, status, status, status, status]);
    const { email: _first, ...known } = answers[0];
    for (const { email, ...other } of answers.slice(1)) expect(other, email).toEqual(known);
  });

  it('an unknown email costs one check on the pool, like a known one, and is still 401 Invalid credentials', async () => {
    await createPasswordUser(ctx.db, 'org', 'known@x', 'correct-horse-1', 'viewer');
    const compare = vi.spyOn(livePool, 'bcryptCompare');
    const known = await login('known@x', 'wrong-password-1');
    expect(compare).toHaveBeenCalledTimes(1);
    const unknown = await login('nobody@x', 'wrong-password-1');
    expect(compare).toHaveBeenCalledTimes(2);
    expect([known.status, unknown.status]).toEqual([401, 401]);
    expect(unknown.body).toEqual(known.body);
  });

  it('a wrong password against a placeholder hash never signs anyone in, whatever the password', async () => {
    for (const password of ['', 'x', 'correct-horse-1']) {
      const r = await login('nobody@x', password);
      expect(r.status).not.toBe(200);
      expect(sessionCookie(r)).toBeUndefined();
    }
  });
});
