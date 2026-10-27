import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb } from '../db/postgres';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';
import { pruneLearningReports, LEARNING_RETENTION_MS } from '../services/airlockLearning';

/**
 * Airlock learning proposals on the hub (GH-294, TEL-3).
 *
 * A hub-joined installation cannot change the org's policy, so a person there
 * forwards its proposed allowlist to the hub: an `airlock.learning-proposal`
 * event through the outbox (/v1/events), host names and counts only. The hub
 * keeps the latest report of each host from each installation and lists them
 * to the admin, deduplicated by host:
 *
 *   GET  /v1/admin/airlock/learning          one row per host, across installations
 *   POST /v1/admin/airlock/learning/accept   allow some of them: a new, audited revision
 *
 * Nothing is applied without an admin, and a host the org's policy already
 * allows, denies or lists as an IOC - or a metadata or private address - is
 * never offered. Run against SQLite and pg-mem, since production is Postgres.
 */

const SECRET = 'a'.repeat(64);
const ADMIN = 'admin@x';
const PASSWORD = 'longenough1';

let __server: any;

type Backend = 'sqlite' | 'postgres';

let seq = 0;
const event = (orgId: string, installationId: string, payload: unknown, occurredAt: string) => ({
  eventId: `ev-${++seq}-${Math.random().toString(36).slice(2)}`,
  installationId,
  orgId,
  occurredAt,
  actor: { osUser: 'tester', gitName: null, gitEmail: `${installationId}@x` },
  type: 'airlock.learning-proposal',
  payload,
});

const proposed = (host: string, over: Record<string, unknown> = {}) => ({
  host,
  hits: 3,
  sources: { tool: 3, proxy: 0, import: 0 },
  evidence: 'agent-reported',
  clients: ['pi'],
  firstSeen: '2026-10-20T10:00:00.000Z',
  lastSeen: '2026-10-27T10:00:00.000Z',
  cardCount: 1,
  ...over,
});

const POLICY = {
  schemaVersion: 1,
  mode: 'enforce',
  models: [],
  appliesWhenModelUnknown: true,
  hosts: { allow: ['github.com'], deny: ['evil.example'] },
  rules: { uploadToUnlistedHost: 'deny', credentialReadWithNetwork: 'deny', namespaceEscape: 'deny', cloudMutation: 'needs-human-approval' },
};

describe.each<Backend>(['sqlite', 'postgres'])('hub airlock learning proposals (%s)', (backend) => {
  let db: HubDb;
  let cookieAdmin: string;
  let cookieViewer: string;
  let cookieOrgB: string;
  let keyAlice: string;
  let keyBob: string;
  let keyB: string;

  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  /** Reports are dated relative to now: retention is clock-relative, so fixed dates would rot. */
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const send = (key: string, inst: string, hosts: unknown[], at = ago(60), org = 'org-a') =>
    supertest(__server).post('/v1/events').set(bearer(key)).send({ events: [event(org, inst, { hosts }, at)] });
  const list = (cookie = cookieAdmin) => supertest(__server).get('/v1/admin/airlock/learning').set('Cookie', cookie);
  const accept = (body: unknown, cookie = cookieAdmin) =>
    supertest(__server).post('/v1/admin/airlock/learning/accept').set('Cookie', cookie).send(body as object);
  const putPolicy = (policy: unknown, cookie = cookieAdmin) =>
    supertest(__server).put('/v1/admin/airlock').set('Cookie', cookie).send({ policy });
  const hostsOf = (body: any): string[] => body.hosts.map((h: any) => h.host);

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
    keyAlice = await issueApiKey(db, 'org-a', 'alice-laptop', { installationId: 'inst-alice' });
    keyBob = await issueApiKey(db, 'org-a', 'bob-laptop', { installationId: 'inst-bob' });
    keyB = await issueApiKey(db, 'org-b', 'other-org', { installationId: 'inst-other' });
    expect((await putPolicy(POLICY)).status).toBe(200);
  });

  afterEach(async () => {
    await drainApp(__server);
    await db.close();
  });

  it('a forwarded proposal is listed to the admin', async () => {
    const r = await send(keyAlice, 'inst-alice', [proposed('api.example.com', { sources: { tool: 1, proxy: 2, import: 0 }, evidence: 'proxy' })]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.revision).toBe(1);
    expect(res.body.hosts).toEqual([expect.objectContaining({
      host: 'api.example.com', installations: 1, hits: 3, proxyHits: 2, evidence: 'proxy', clients: ['pi'],
      firstSeen: '2026-10-20T10:00:00.000Z', lastSeen: '2026-10-27T10:00:00.000Z',
    })]);
  });

  it('the same host from many installations is one row; a later report from one installation replaces its own', async () => {
    await send(keyAlice, 'inst-alice', [proposed('api.example.com', { hits: 5 })], ago(30));
    await send(keyBob, 'inst-bob', [proposed('api.example.com', { hits: 2, clients: ['opencode'] }), proposed('docs.example.org')]);
    await send(keyAlice, 'inst-alice', [proposed('api.example.com', { hits: 7 })], ago(10));
    // An older report arriving late does not roll it back.
    await send(keyAlice, 'inst-alice', [proposed('api.example.com', { hits: 1 })], ago(50));
    const res = await list();
    expect(hostsOf(res.body)).toEqual(['api.example.com', 'docs.example.org']);
    const api = res.body.hosts[0];
    expect(api).toMatchObject({ installations: 2, hits: 9 });
    expect([...api.clients].sort()).toEqual(['opencode', 'pi']);
  });

  it('never offers what the org policy already allows, denies or lists as an IOC, nor a metadata or private host', async () => {
    await supertest(__server).put('/v1/admin/airlock/ioc').set('Cookie', cookieAdmin).send({ hosts: ['bad.example'] });
    await send(keyAlice, 'inst-alice', ['github.com', 'evil.example', 'bad.example', '169.254.169.254', '10.0.0.4', 'ok.example.com'].map(h => proposed(h)));
    const res = await list();
    expect(hostsOf(res.body)).toEqual(['ok.example.com']);
  });

  it('an entry that is not a bare host is not kept, and nor are fields beyond host names and counts', async () => {
    await send(keyAlice, 'inst-alice', [
      proposed('https://x.example.com/path?q=1'),
      proposed('x.example.com/path'),
      proposed('*.example.com'),
      { ...proposed('kept.example.com'), command: 'curl https://kept.example.com/secret' },
    ]);
    expect(hostsOf((await list()).body)).toEqual(['kept.example.com']);
    const rows = await db.all<any>('SELECT * FROM airlock_learning_reports');
    expect(JSON.stringify(rows)).not.toMatch(/secret|curl/);
  });

  it('a viewer cannot read or accept, and another org sees nothing', async () => {
    await send(keyAlice, 'inst-alice', [proposed('api.example.com')]);
    expect((await list(cookieViewer)).status).toBe(403);
    expect((await accept({ hosts: ['api.example.com'], expectedRevision: 1 }, cookieViewer)).status).toBe(403);
    expect(hostsOf((await list(cookieOrgB)).body)).toEqual([]);
    await send(keyB, 'inst-other', [proposed('other.example.com')], undefined, 'org-b');
    expect(hostsOf((await list()).body)).toEqual(['api.example.com']);
  });

  it('an installation key cannot accept: it is an admin route', async () => {
    await send(keyAlice, 'inst-alice', [proposed('api.example.com')]);
    const r = await supertest(__server).post('/v1/admin/airlock/learning/accept').set(bearer(keyAlice)).send({ hosts: ['api.example.com'], expectedRevision: 1 });
    expect([401, 403]).toContain(r.status);
    expect((await supertest(__server).get('/v1/admin/airlock').set('Cookie', cookieAdmin)).body.revision).toBe(1);
  });

  it('the admin accepts a subset: a new revision allows exactly those hosts, and it is audited', async () => {
    await send(keyAlice, 'inst-alice', [proposed('api.example.com'), proposed('docs.example.org')]);
    const r = await accept({ hosts: ['api.example.com'], expectedRevision: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.revision).toBe(2);
    expect(r.body.policy.hosts.allow).toEqual(['github.com', 'api.example.com']);
    expect(r.body.policy.hosts.deny).toEqual(['evil.example']);
    expect(r.body.policy.mode).toBe('enforce');
    expect(hostsOf((await list()).body)).toEqual(['docs.example.org']);

    const deadline = Date.now() + 3000;
    let rows: any[] = [];
    for (;;) {
      rows = (await supertest(__server).get('/v1/admin/audit?area=airlock').set('Cookie', cookieAdmin)).body.rows ?? [];
      if (rows.some(x => x.action === 'airlock.learning-accept') || Date.now() > deadline) break;
      await new Promise(res => setTimeout(res, 20));
    }
    const row = rows.find(x => x.action === 'airlock.learning-accept');
    expect(row).toBeDefined();
    expect(row.actorEmail).toBe(ADMIN);
    expect(row.before.revision).toBe(1);
    expect(row.after.revision).toBe(2);
    expect(row.after.policy.hosts.allow).toContain('api.example.com');
  });

  it('a stale revision is a conflict; a host nobody proposed, or one excluded, cannot be accepted', async () => {
    await send(keyAlice, 'inst-alice', [proposed('api.example.com'), proposed('evil.example')]);
    expect((await accept({ hosts: ['api.example.com'], expectedRevision: 0 })).status).toBe(409);
    expect((await accept({ hosts: ['never.example.com'], expectedRevision: 1 })).status).toBe(400);
    expect((await accept({ hosts: ['evil.example'], expectedRevision: 1 })).status).toBe(400);
    expect((await accept({ hosts: [], expectedRevision: 1 })).status).toBe(400);
    expect((await supertest(__server).get('/v1/admin/airlock').set('Cookie', cookieAdmin)).body.revision).toBe(1);
  });

  describe('ranking and eligibility (round 2, finding 2)', () => {
    it('one ranking: proxy evidence, then installations, then hits, then host', async () => {
      await send(keyAlice, 'inst-alice', [
        proposed('c.example.com', { hits: 50 }),
        proposed('b.example.com', { hits: 1, sources: { tool: 0, proxy: 1, import: 0 }, evidence: 'proxy' }),
        proposed('a.example.com', { hits: 5 }),
        proposed('d.example.com', { hits: 5 }),
      ]);
      await send(keyBob, 'inst-bob', [proposed('a.example.com', { hits: 1 })]);
      expect(hostsOf((await list()).body)).toEqual(['b.example.com', 'a.example.com', 'c.example.com', 'd.example.com']);
    });

    it('2000+ higher-ranked hosts a newer deny entry covers do not hide the eligible hosts ranked below them', async () => {
      const blocked = Array.from({ length: 2100 }, (_, i) => proposed(`h${i}.blocked.example`, { hits: 100, sources: { tool: 0, proxy: 100, import: 0 }, evidence: 'proxy' }));
      for (let i = 0; i < blocked.length; i += 500) await send(keyAlice, 'inst-alice', blocked.slice(i, i + 500));
      await send(keyBob, 'inst-bob', [proposed('low1.example.com', { hits: 1 }), proposed('low2.example.com', { hits: 2 })]);
      expect((await putPolicy({ ...POLICY, hosts: { allow: ['github.com'], deny: ['evil.example', '*.blocked.example'] } })).status).toBe(200);
      const res = await list();
      expect(hostsOf(res.body)).toEqual(['low2.example.com', 'low1.example.com']);
      expect((await accept({ hosts: ['low1.example.com'], expectedRevision: 2 })).status).toBe(200);
    }, 120_000);
  });

  describe('bounds (review finding 7)', () => {
    const count = async () => Number((await db.get<any>("SELECT COUNT(*) AS n FROM airlock_learning_reports WHERE org_id = 'org-a'"))!.n);

    it('a host the org policy already covers when it arrives is not stored', async () => {
      await send(keyAlice, 'inst-alice', [proposed('github.com'), proposed('evil.example'), proposed('fresh.example.com')]);
      const rows = await db.all<any>("SELECT host FROM airlock_learning_reports WHERE org_id = 'org-a'");
      expect(rows.map(r => r.host)).toEqual(['fresh.example.com']);
    });

    it('a report past the retention is dropped on the next insert', async () => {
      const old = new Date(Date.now() - LEARNING_RETENTION_MS - 60_000).toISOString();
      await send(keyAlice, 'inst-alice', [proposed('old.example.com')], old);
      await send(keyBob, 'inst-bob', [proposed('new.example.com')], new Date().toISOString());
      expect(hostsOf((await list()).body)).toEqual(['new.example.com']);
    });

    it('an org keeps at most the cap of report rows, the oldest reports going first', async () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        await send(keyAlice, 'inst-alice', [proposed(`h${i}.example.com`)], new Date(now - (5 - i) * 60_000).toISOString());
      }
      expect(await count()).toBe(5);
      await pruneLearningReports(db, 'org-a', now, 3);
      expect(await count()).toBe(3);
      expect(hostsOf((await list()).body).sort()).toEqual(['h2.example.com', 'h3.example.com', 'h4.example.com']);
    });
  });
});
