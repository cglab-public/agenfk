/** Keys minted by the real onboarding flows (device code, invite) are installation-bound; a flag can refuse unbound ones. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-ingest-binding-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); };

const event = (installationId: string, eventId: string) => ({
  eventId, installationId, orgId: 'org', occurredAt: '2026-05-03T10:00:00Z',
  actor: { osUser: 'alice', gitName: 'Alice', gitEmail: 'alice@example.com' },
  type: 'item.created', projectId: 'p1', itemId: 'i1', payload: { title: 'demo' },
});

const FLAG = 'AGENFK_HUB_REQUIRE_BOUND_KEYS';
let server: any = null;
let ctx: any = null;
let adminCookie = '';
let savedFlag: string | undefined;

const post = (token: string, events: unknown[]) =>
  supertest(server).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });
const eventCount = async (): Promise<number> => Number((await ctx.db.get('SELECT COUNT(*) AS c FROM events')).c);
const installationExists = async (id: string): Promise<boolean> => !!(await ctx.db.get('SELECT 1 AS x FROM installations WHERE id = ?', [id]));

async function deviceToken(installationId: string): Promise<string> {
  const start = await supertest(server).post('/hub/device/start').send({ installation: { installationId, osUser: 'alice', gitName: 'Alice', gitEmail: 'alice@example.com' } });
  expect(start.status).toBe(200);
  expect((await supertest(server).post('/hub/device/approve').set('Cookie', adminCookie).send({ userCode: start.body.userCode })).status).toBe(200);
  const poll = await supertest(server).post('/hub/device/poll').send({ deviceCode: start.body.deviceCode });
  expect(poll.body.status).toBe('approved');
  return poll.body.token as string;
}
async function inviteToken(installationId: string): Promise<string> {
  const created = await supertest(server).post('/hub/invite/create').set('Cookie', adminCookie).send({});
  const r = await supertest(server).post('/hub/invite/redeem').send({
    inviteToken: created.body.inviteToken,
    installation: { installationId, osUser: 'alice', gitName: 'Alice', gitEmail: 'alice@example.com' },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.token as string;
}

beforeEach(async () => {
  cleanup();
  savedFlag = process.env[FLAG];
  delete process.env[FLAG];
  const out = await createHubApp({ dbPath: TEST_DB, secretKey: '0'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' } as any);
  server = out.app.listen(0);
  ctx = out.ctx;
  await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
  adminCookie = await loginAs(server, 'admin@x', 'longenough1');
});
afterEach(async () => {
  if (savedFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = savedFlag;
  if (server) await drainApp(server);
  if (ctx) await ctx.db.close();
  server = null; ctx = null;
  cleanup();
});

describe.each([
  ['device-code flow', deviceToken],
  ['invite-redeem flow', inviteToken],
] as const)('a key minted by the %s is bound, and refuses another installation', (_name, mint) => {
  it('rejects an event naming a different installation as foreign_installation, and records nothing for it', async () => {
    const token = await mint('inst-mine');
    const r = await post(token, [event('inst-victim', 'foreign-1')]);
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(0);
    expect(r.body.rejected).toBe(1);
    expect(r.body.rejections).toEqual([{ eventId: 'foreign-1', reason: 'foreign_installation' }]);
    expect(await eventCount()).toBe(0);
    // The rejection must not register the id it refused.
    expect(await installationExists('inst-victim')).toBe(false);
  });

  it('accepts its own installation', async () => {
    const token = await mint('inst-mine');
    const r = await post(token, [event('inst-mine', 'own-1')]);
    expect(r.body).toMatchObject({ ingested: 1, rejected: 0 });
    expect(await eventCount()).toBe(1);
  });

  it('in a mixed batch, ingests the key\'s own events and rejects only the foreign ones', async () => {
    const token = await mint('inst-mine');
    const r = await post(token, [event('inst-mine', 'own-1'), event('inst-victim', 'foreign-1'), event('inst-mine', 'own-2')]);
    expect(r.body.ingested).toBe(2);
    expect(r.body.rejections).toEqual([{ eventId: 'foreign-1', reason: 'foreign_installation' }]);
    expect(await eventCount()).toBe(2);
    expect(await installationExists('inst-victim')).toBe(false);
  });
});

describe('a legacy unbound (org-wide) key keeps working while AGENFK_HUB_REQUIRE_BOUND_KEYS is off', () => {
  it('accepts events from any installation of its org, as before', async () => {
    const token = await issueApiKey(ctx.db, 'org', 'legacy-fleet');
    const r = await post(token, [event('inst-a', 'a-1'), event('inst-b', 'b-1')]);
    expect(r.body).toMatchObject({ ingested: 2, rejected: 0 });
  });

  it.each(['', '0', 'false', 'no'])('and the flag set to %j does not turn the gate on', async (value) => {
    process.env[FLAG] = value;
    const token = await issueApiKey(ctx.db, 'org', 'legacy-fleet');
    expect((await post(token, [event('inst-a', 'a-1')])).body.ingested).toBe(1);
  });
});

describe('boot says where AGENFK_HUB_REQUIRE_BOUND_KEYS stands', () => {
  const logsOf = async (value: string | undefined, seed?: () => Promise<void>) => {
    if (server) { await drainApp(server); server = null; }
    if (ctx) { await ctx.db.close(); ctx = null; }
    if (value === undefined) delete process.env[FLAG]; else process.env[FLAG] = value;
    const lines: string[] = [];
    const capture = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    const log = vi.spyOn(console, 'log').mockImplementation(capture);
    const warn = vi.spyOn(console, 'warn').mockImplementation(capture);
    try {
      const out = await createHubApp({ dbPath: TEST_DB, secretKey: '0'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' } as any);
      server = out.app.listen(0); ctx = out.ctx;
      if (seed) { await seed(); }
    } finally { log.mockRestore(); warn.mockRestore(); }
    return lines.filter(l => l.includes('REQUIRE_BOUND_KEYS'));
  };

  it('is silent when the flag is off or unset', async () => {
    expect(await logsOf(undefined)).toEqual([]);
    expect(await logsOf('0')).toEqual([]);
  });

  it('names an unrecognised value instead of silently staying off', async () => {
    const lines = await logsOf('enabled');
    expect(lines.join('\n')).toMatch(/not recognised/);
  });

  it('when on, says how many live unbound keys it will refuse', async () => {
    await logsOf(undefined, async () => {
      await issueApiKey(ctx.db, 'org', 'legacy-1');
      await issueApiKey(ctx.db, 'org', 'legacy-2');
      await issueApiKey(ctx.db, 'org', 'bound', { installationId: 'inst-x' });
    });
    const lines = await logsOf('1');
    expect(lines.join('\n')).toMatch(/2 live key\(s\) are unbound/);
  });
});

describe('AGENFK_HUB_REQUIRE_BOUND_KEYS refuses unbound keys on ingest', () => {
  it.each(['1', 'true', 'TRUE'])('with the flag set to %j, an unbound key gets 403 and an error body, and nothing is ingested', async (value) => {
    process.env[FLAG] = value;
    const token = await issueApiKey(ctx.db, 'org', 'legacy-fleet');
    const r = await post(token, [event('inst-a', 'a-1')]);
    expect(r.status).toBe(403);
    // The spoke reads a JSON `error` string as the hub's own refusal, not a proxy's.
    expect(typeof r.body.error).toBe('string');
    expect(r.body.error).toMatch(/bound|installation/i);
    expect(await eventCount()).toBe(0);
    expect(await installationExists('inst-a')).toBe(false);
  });

  it('still accepts a bound key, from either onboarding flow', async () => {
    process.env[FLAG] = '1';
    expect((await post(await deviceToken('inst-dev'), [event('inst-dev', 'd-1')])).body.ingested).toBe(1);
    expect((await post(await inviteToken('inst-inv'), [event('inst-inv', 'i-1')])).body.ingested).toBe(1);
  });

  it('is read per request, so an operator can switch it without a rebuild', async () => {
    const token = await issueApiKey(ctx.db, 'org', 'legacy-fleet');
    expect((await post(token, [event('inst-a', 'a-1')])).status).toBe(200);
    process.env[FLAG] = '1';
    expect((await post(token, [event('inst-a', 'a-2')])).status).toBe(403);
    delete process.env[FLAG];
    expect((await post(token, [event('inst-a', 'a-3')])).status).toBe(200);
  });

  it('leaves everything that is not ingest alone: an unbound key can still ping', async () => {
    process.env[FLAG] = '1';
    const token = await issueApiKey(ctx.db, 'org', 'legacy-fleet');
    const r = await supertest(server).get('/v1/ping').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.installationId).toBeNull();
  });

  it('still answers 401 for a missing, unknown or REVOKED key before it says anything about binding', async () => {
    process.env[FLAG] = '1';
    expect((await supertest(server).post('/v1/events').send({ events: [] })).status).toBe(401);
    expect((await supertest(server).post('/v1/events').set('Authorization', 'Bearer agk_nope').send({ events: [] })).status).toBe(401);
    const revoked = await issueApiKey(ctx.db, 'org', 'legacy-fleet');
    await ctx.db.run("UPDATE api_keys SET revoked_at = datetime('now') WHERE label = 'legacy-fleet'");
    expect((await post(revoked, [event('inst-a', 'a-1')])).status).toBe(401);
  });

  it.each(['yes', 'YES', 'on'])('accepts %j as on', async (value) => {
    process.env[FLAG] = value;
    expect((await post(await issueApiKey(ctx.db, 'org', 'legacy-fleet'), [event('inst-a', 'a-1')])).status).toBe(403);
  });

  it('refuses an unbound key even when its label would let it bind itself on first report (it could never get that far)', async () => {
    process.env[FLAG] = '1';
    const onboarding = await issueApiKey(ctx.db, 'org', 'invite:alice@example.com');
    expect((await post(onboarding, [event('inst-a', 'a-1')])).status).toBe(403);
    expect(await eventCount()).toBe(0);
  });
});
