import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb } from '../db/postgres';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { ORG_ID_CHILD_TABLES } from '../routes/orgRename';
import { putAirlockPolicy as putPolicy, putAirlockIocHosts as putIoc, getAirlockPolicy as getPolicy, AirlockPolicyError } from '../services/airlock';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

/**
 * Airlock on the hub (GH-294, T3): the org's policy is the hub's to keep.
 *
 *   GET  /v1/airlock/policy      an installation's read (api key), ETag + 304
 *   GET  /v1/admin/airlock       the admin's read
 *   PUT  /v1/admin/airlock       the admin's write of the policy (validated)
 *   PUT  /v1/admin/airlock/ioc   the admin's write of the IOC host list
 *
 * The org always comes from the credential. Run against SQLite and pg-mem, since
 * production is Postgres and its rows come back in different shapes.
 */

const SECRET = 'a'.repeat(64);
const ADMIN = 'admin@x';
const PASSWORD = 'longenough1';

let __server: any;

type Backend = 'sqlite' | 'postgres';

const POLICY = {
  schemaVersion: 1,
  mode: 'enforce',
  models: [{ client: 'pi', provider: 'cloudflare-workers-ai' }],
  appliesWhenModelUnknown: true,
  hosts: { allow: ['github.com'], deny: ['evil.example'] },
};

describe.each<Backend>(['sqlite', 'postgres'])('hub airlock policy (%s)', (backend) => {
  let db: HubDb;
  let cookieAdmin: string;
  let cookieViewer: string;
  let cookieOrgB: string;
  let keyA: string;
  let keyB: string;

  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  const install = (key: string, etag?: string) => {
    const r = supertest(__server).get('/v1/airlock/policy').set(bearer(key));
    return etag ? r.set('If-None-Match', etag) : r;
  };
  const adminGet = (cookie = cookieAdmin) => supertest(__server).get('/v1/admin/airlock').set('Cookie', cookie);
  const adminPut = (body: Record<string, unknown>, cookie = cookieAdmin) =>
    supertest(__server).put('/v1/admin/airlock').set('Cookie', cookie).send(body as any);
  const iocPut = (body: Record<string, unknown>, cookie = cookieAdmin) =>
    supertest(__server).put('/v1/admin/airlock/ioc').set('Cookie', cookie).send(body as any);

  beforeEach(async () => {
    db = backend === 'sqlite' ? await openSqliteDb(':memory:') : await openPgMemDb();
    const out = await createHubApp({
      dbPath: ':memory:', secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a', db,
    } as any);
    if (__server) await new Promise<void>(r => __server.close(() => r()));
    __server = out.app.listen(0);
    await db.run("INSERT INTO orgs (id, name) VALUES ('org-b', 'org-b') ON CONFLICT (id) DO NOTHING");
    await createPasswordUser(db, 'org-a', ADMIN, PASSWORD, 'admin');
    await createPasswordUser(db, 'org-a', 'viewer@x', PASSWORD, 'viewer');
    await createPasswordUser(db, 'org-b', 'admin-b@x', PASSWORD, 'admin');
    cookieAdmin = await loginAs(__server, ADMIN, PASSWORD);
    cookieViewer = await loginAs(__server, 'viewer@x', PASSWORD);
    cookieOrgB = await loginAs(__server, 'admin-b@x', PASSWORD);
    keyA = await issueApiKey(db, 'org-a', 'alice-laptop', { installationId: 'inst-alice' });
    keyB = await issueApiKey(db, 'org-b', 'other-org', { installationId: 'inst-other' });
  });

  afterEach(async () => {
    await drainApp(__server);
    await db.close();
  });

  describe('GET /v1/airlock/policy (installation)', () => {
    it('no api key is 401', async () => {
      const r = await supertest(__server).get('/v1/airlock/policy');
      expect(r.status).toBe(401);
    });

    it('an org with no policy returns {policy: null}', async () => {
      const r = await install(keyA);
      expect(r.status).toBe(200);
      expect(r.body.policy).toBeNull();
      expect(r.body.revision).toBe(0);
    });

    it('admin PUT bumps the revision; the install GET returns it with an ETag, and If-None-Match is 304', async () => {
      const put1 = await adminPut({ policy: POLICY });
      expect(put1.status, JSON.stringify(put1.body)).toBe(200);
      expect(put1.body.revision).toBe(1);
      const put2 = await adminPut({ policy: { ...POLICY, mode: 'observe' } });
      expect(put2.status).toBe(200);
      expect(put2.body.revision).toBe(2);

      const r = await install(keyA);
      expect(r.status).toBe(200);
      expect(r.body.revision).toBe(2);
      expect(typeof r.body.revision).toBe('number');
      expect(r.body.policy.mode).toBe('observe');
      expect(r.body.policy.hosts.allow).toEqual(['github.com']);
      const etag = r.headers.etag;
      expect(etag).toMatch(/^W\/"/);

      const again = await install(keyA, etag);
      expect(again.status).toBe(304);
    });

    it('an IOC-only change changes the ETag (the policy revision does not move)', async () => {
      await adminPut({ policy: POLICY });
      const first = await install(keyA);
      const etag = first.headers.etag;
      const ioc = await iocPut({ hosts: ['bad.example', '203.0.113.0/24'] });
      expect(ioc.status, JSON.stringify(ioc.body)).toBe(200);

      const second = await install(keyA, etag);
      expect(second.status).toBe(200);
      expect(second.headers.etag).not.toBe(etag);
      expect(second.body.revision).toBe(first.body.revision);
      expect(second.body.policy.iocHosts.hosts).toEqual(['bad.example', '203.0.113.0/24']);
      expect(second.body.policy.iocHosts.revision).not.toBe(first.body.policy.iocHosts.revision);
    });

    it("org B's key cannot see org A's policy", async () => {
      await adminPut({ policy: POLICY });
      const r = await install(keyB);
      expect(r.status).toBe(200);
      expect(r.body.policy).toBeNull();
    });

    it('a policy PUT keeps the IOC list the admin already set', async () => {
      await adminPut({ policy: POLICY });
      await iocPut({ hosts: ['bad.example'] });
      await adminPut({ policy: { ...POLICY, mode: 'observe', iocHosts: { revision: 'x', hosts: [] } } });
      const r = await install(keyA);
      expect(r.body.policy.mode).toBe('observe');
      expect(r.body.policy.iocHosts.hosts).toEqual(['bad.example']);
    });
  });

  describe('admin routes', () => {
    it('GET with no policy yet says so', async () => {
      const r = await adminGet();
      expect(r.status).toBe(200);
      expect(r.body.policy).toBeNull();
      expect(r.body.revision).toBe(0);
    });

    it('GET after a PUT returns the policy, revision and who saved it', async () => {
      await adminPut({ policy: POLICY });
      const r = await adminGet();
      expect(r.status).toBe(200);
      expect(r.body.revision).toBe(1);
      expect(r.body.policy.mode).toBe('enforce');
      expect(r.body.updatedByEmail).toBe(ADMIN);
      expect(typeof r.body.updatedAt).toBe('string');
    });

    it('a machine image the admin sets is stored and delivered to installations; a save without it clears it (CGLAB-696)', async () => {
      const put1 = await adminPut({ policy: { ...POLICY, machineImage: 'ghcr.io/acme/airlock:1.2' } });
      expect(put1.status, JSON.stringify(put1.body)).toBe(200);
      expect((await adminGet()).body.policy.machineImage).toBe('ghcr.io/acme/airlock:1.2');
      expect((await install(keyA)).body.policy.machineImage).toBe('ghcr.io/acme/airlock:1.2');
      await adminPut({ policy: POLICY });
      expect('machineImage' in (await install(keyA)).body.policy).toBe(false);
    });

    it('the home access the admin sets is delivered to installations; a save without it protects credentials again (story 525cd331)', async () => {
      const put1 = await adminPut({ policy: { ...POLICY, homeAccess: 'home-read-write' } });
      expect(put1.status, JSON.stringify(put1.body)).toBe(200);
      expect((await install(keyA)).body.policy.homeAccess).toBe('home-read-write');
      await adminPut({ policy: POLICY });
      expect('homeAccess' in (await install(keyA)).body.policy).toBe(false);
      const bad = await adminPut({ policy: { ...POLICY, homeAccess: 'everything' } });
      expect(bad.status).toBe(400);
      expect(bad.body.errors.join(' ')).toMatch(/homeAccess/);
    });

    it('a PUT naming something other than an image reference as the machine image is 400 and nothing is stored', async () => {
      const r = await adminPut({ policy: { ...POLICY, machineImage: 'ghcr.io/acme/airlock:1 --trust-host-certs' } });
      expect(r.status).toBe(400);
      expect(r.body.errors.join(' ')).toMatch(/machineImage/);
      expect((await adminGet()).body.policy).toBeNull();
    });

    it('a PUT allow-listing a metadata host is 400 and nothing is stored', async () => {
      const r = await adminPut({ policy: { ...POLICY, hosts: { allow: ['169.254.169.254'], deny: [] } } });
      expect(r.status).toBe(400);
      expect(r.body.errors.join(' ')).toMatch(/metadata/);
      expect((await adminGet()).body.policy).toBeNull();
    });

    it('an IOC PUT with an invalid host is 400', async () => {
      await adminPut({ policy: POLICY });
      const r = await iocPut({ hosts: ['not a host!'] });
      expect(r.status).toBe(400);
    });

    it('an IOC PUT before any policy is refused', async () => {
      const r = await iocPut({ hosts: ['bad.example'] });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('no_policy');
    });

    it('a stale expectedRevision is 409 and nothing changes', async () => {
      await adminPut({ policy: POLICY });
      const r = await adminPut({ policy: { ...POLICY, mode: 'off' }, expectedRevision: 0 });
      expect(r.status).toBe(409);
      expect((await adminGet()).body.policy.mode).toBe('enforce');
    });

    it('an api key cannot PUT /v1/admin/airlock', async () => {
      const r = await supertest(__server).put('/v1/admin/airlock').set(bearer(keyA)).send({ policy: POLICY });
      expect(r.status).toBe(401);
      expect((await adminGet()).body.policy).toBeNull();
    });

    it('a viewer cannot PUT', async () => {
      const r = await adminPut({ policy: POLICY }, cookieViewer);
      expect(r.status).toBe(403);
    });

    it("org B's admin sees only org B", async () => {
      await adminPut({ policy: POLICY });
      expect((await adminGet(cookieOrgB)).body.policy).toBeNull();
      await adminPut({ policy: { ...POLICY, mode: 'observe' } }, cookieOrgB);
      expect((await adminGet()).body.policy.mode).toBe('enforce');
      expect((await install(keyB)).body.policy.mode).toBe('observe');
    });

    it('a PUT writes a config_audit row with before and after', async () => {
      await adminPut({ policy: POLICY });
      await adminPut({ policy: { ...POLICY, mode: 'observe' } });
      await iocPut({ hosts: ['bad.example'] });
      const deadline = Date.now() + 3000;
      let rows: any[] = [];
      for (;;) {
        rows = (await supertest(__server).get('/v1/admin/audit?area=airlock').set('Cookie', cookieAdmin)).body.rows ?? [];
        if (rows.length >= 3 || Date.now() > deadline) break;
        await new Promise(res => setTimeout(res, 20));
      }
      const updates = rows.filter(r => r.action === 'airlock.update');
      expect(updates).toHaveLength(2);
      const second = updates.find(r => r.before !== null)!;
      expect(second.before.policy.mode).toBe('enforce');
      expect(second.after.policy.mode).toBe('observe');
      expect(second.after.revision).toBe(2);
      const ioc = rows.find(r => r.action === 'airlock.ioc');
      expect(ioc.after.policy.iocHosts.hosts).toEqual(['bad.example']);
    });
  });

  describe('limits on what an admin may send', () => {
    it('a body over the route limit is 413, not parsed', async () => {
      const huge = { policy: { ...POLICY, hosts: { allow: [], deny: [] } }, pad: 'x'.repeat(300 * 1024) };
      const r = await adminPut(huge);
      expect(r.status).toBe(413);
      expect((await adminGet()).body.policy).toBeNull();
    });

    it('too many hosts in a list is 400 before validation', async () => {
      const many = Array.from({ length: 1001 }, (_, i) => `h${i}.example`);
      const r = await adminPut({ policy: { ...POLICY, hosts: { allow: many, deny: [] } } });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(/at most 1000/);
    });

    it('a host pattern longer than 253 characters is 400', async () => {
      const r = await adminPut({ policy: { ...POLICY, hosts: { allow: [`${'a'.repeat(250)}.example`], deny: [] } } });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(/253/);
    });

    it('too many models is 400', async () => {
      const r = await adminPut({ policy: { ...POLICY, models: Array.from({ length: 101 }, () => ({ client: 'pi' })) } });
      expect(r.status).toBe(400);
    });

    it('too many IOC hosts is 400', async () => {
      await adminPut({ policy: POLICY });
      const r = await iocPut({ hosts: Array.from({ length: 10001 }, (_, i) => `h${i}.example`) });
      expect(r.status).toBe(400);
    });

    it('duplicate hosts are stored once', async () => {
      await adminPut({ policy: { ...POLICY, hosts: { allow: ['github.com', 'GitHub.com', 'github.com'], deny: [] } } });
      expect((await install(keyA)).body.policy.hosts.allow).toEqual(['github.com']);
    });
  });

  describe('writes are compare-and-swap in the database, not only in this process', () => {
    /** A db whose first read of airlock_policies is followed by `interleave` - another process's write. */
    function interleaved(interleave: () => Promise<unknown>): HubDb {
      let fired = false;
      return new Proxy(db, {
        get(target, prop) {
          if (prop === 'get') {
            return async (sql: string, params?: any) => {
              const row = await target.get(sql, params);
              if (!fired && /FROM airlock_policies/.test(sql)) { fired = true; await interleave(); }
              return row;
            };
          }
          const v = (target as any)[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }) as HubDb;
    }

    it('a policy save that lost a race is refused and the winner stands', async () => {
      await putPolicy(db, 'org-a', POLICY, undefined, ADMIN);
      const racer = interleaved(() => putPolicy(db, 'org-a', { ...POLICY, mode: 'observe' }, undefined, 'other@x'));
      await expect(putPolicy(racer, 'org-a', { ...POLICY, mode: 'off' }, undefined, ADMIN)).rejects.toMatchObject({ code: 'revision_conflict' });
      const v = await getPolicy(db, 'org-a');
      expect(v.revision).toBe(2);
      expect(v.policy?.mode).toBe('observe');
    });

    it('two first saves: the second is refused, not overwritten', async () => {
      const racer = interleaved(() => putPolicy(db, 'org-a', { ...POLICY, mode: 'observe' }, undefined, 'other@x'));
      await expect(putPolicy(racer, 'org-a', POLICY, undefined, ADMIN)).rejects.toBeInstanceOf(AirlockPolicyError);
      const v = await getPolicy(db, 'org-a');
      expect(v.revision).toBe(1);
      expect(v.policy?.mode).toBe('observe');
    });

    it('an IOC save that lost a race is refused', async () => {
      await putPolicy(db, 'org-a', POLICY, undefined, ADMIN);
      const racer = interleaved(() => putIoc(db, 'org-a', ['first.example'], 'other@x'));
      await expect(putIoc(racer, 'org-a', ['second.example'], ADMIN)).rejects.toMatchObject({ code: 'revision_conflict' });
      const v = await getPolicy(db, 'org-a');
      expect(v.iocRevision).toBe(1);
      expect(v.policy?.iocHosts.hosts).toEqual(['first.example']);
    });

    it('a policy save racing an IOC save keeps both: neither overwrites the other', async () => {
      await putPolicy(db, 'org-a', POLICY, undefined, ADMIN);
      const racer = interleaved(() => putIoc(db, 'org-a', ['bad.example'], 'other@x'));
      await putPolicy(racer, 'org-a', { ...POLICY, mode: 'observe' }, undefined, ADMIN);
      const v = await getPolicy(db, 'org-a');
      expect(v.policy?.mode).toBe('observe');
      expect(v.policy?.iocHosts.hosts).toEqual(['bad.example']);
      expect(v.revision).toBe(2);
      expect(v.iocRevision).toBe(1);
    });
  });

  it('the audit row shows each rule\'s action, not a redaction', async () => {
    await adminPut({ policy: POLICY });
    const deadline = Date.now() + 3000;
    let row: any;
    for (;;) {
      const rows = (await supertest(__server).get('/v1/admin/audit?area=airlock').set('Cookie', cookieAdmin)).body.rows ?? [];
      row = rows.find((r: any) => r.action === 'airlock.update');
      if (row || Date.now() > deadline) break;
      await new Promise(res => setTimeout(res, 20));
    }
    expect(JSON.stringify(row.after)).not.toMatch(/\[secret/);
    expect(row.after.policy.rules).toEqual(expect.arrayContaining([
      { rule: 'credentialReadWithNetwork', action: 'deny' },
      { rule: 'cloudMutation', action: 'needs-human-approval' },
    ]));
  });

  describe('PO-1: per-project overrides', () => {
    const PROJECTS = { 'git@github.com:Acme/api.git': { hosts: { allow: ['pypi.org'], deny: [] }, rules: { cloudMutation: 'deny' } } };

    it('are stored under their repository and delivered to installations with the policy', async () => {
      expect((await adminPut({ policy: { ...POLICY, projects: PROJECTS } })).status).toBe(200);
      const res = await install(keyA);
      expect(res.body.policy.projects).toEqual({ 'github.com/acme/api': { hosts: { allow: ['pypi.org'], deny: [] }, rules: { cloudMutation: 'deny' } } });
    });

    it('a save that does not carry them keeps them; one that carries them replaces them', async () => {
      await adminPut({ policy: { ...POLICY, projects: PROJECTS } });
      await adminPut({ policy: { ...POLICY, mode: 'observe' }, expectedRevision: 1 });
      let v = await getPolicy(db, 'org-a');
      expect(v.policy?.mode).toBe('observe');
      expect(Object.keys(v.policy?.projects ?? {})).toEqual(['github.com/acme/api']);
      await adminPut({ policy: { ...POLICY, projects: {} }, expectedRevision: 2 });
      v = await getPolicy(db, 'org-a');
      expect(v.policy?.projects).toBeUndefined();
    });

    it('the overrides, and each override\'s host lists, are capped', async () => {
      const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`acme/r${i}`, { rules: { cloudMutation: 'deny' } }]));
      expect(JSON.stringify((await adminPut({ policy: { ...POLICY, projects: many } })).body)).toMatch(/at most 500 overrides/);
      const big = { 'acme/api': { hosts: { allow: Array.from({ length: 1001 }, (_, i) => `h${i}.example`) } } };
      const res = await adminPut({ policy: { ...POLICY, projects: big } });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/hosts\.allow/);
    });

    it('two keys naming one repository cannot unite past the cap', async () => {
      const hosts = (tag: string) => Array.from({ length: 600 }, (_, i) => `${tag}${i}.example`);
      const res = await adminPut({ policy: { ...POLICY, projects: { 'acme/api': { hosts: { allow: hosts('a') } }, 'git@github.com:acme/api.git': { hosts: { allow: hosts('b') } } } } });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/at most 1000/);
    });

    it('a bad override is refused, saying where', async () => {
      const res = await adminPut({ policy: { ...POLICY, projects: { 'not a repo': { rules: { cloudMutation: 'deny' } } } } });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/projects\[\\"not a repo\\"\]/);
    });
  });

  it('an org rename carries the policy along', () => {
    expect(ORG_ID_CHILD_TABLES).toContain('airlock_policies');
  });
});
