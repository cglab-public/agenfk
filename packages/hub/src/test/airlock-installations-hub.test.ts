import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb } from '../db/postgres';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { ORG_ID_CHILD_TABLES } from '../routes/orgRename';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

/**
 * Which Airlock policy each installation applies (GH-294, HUB-2).
 *
 * An installation reports, through its event stream (as fleet upgrades do),
 * the revision it applied (`airlock.policy-applied`) and a hub policy it
 * refused as invalid (`airlock.policy-refused`). The hub keeps the last of each
 * per installation, in the installation's org, and the admin reads:
 *
 *   GET /v1/admin/airlock/installations   applied vs current revision, behind flagged
 *   GET /v1/admin/airlock/history         the policy's revisions, from the config audit
 *
 * Report times are the reports' own, read as ISO UTC; one dated more than
 * five minutes past the hub's clock is rejected, so fixtures are dated in the past.
 *
 * Run against SQLite and pg-mem, since production is Postgres.
 */

const SECRET = 'a'.repeat(64);
const ADMIN = 'admin@x';
const PASSWORD = 'longenough1';

let __server: any;

type Backend = 'sqlite' | 'postgres';

const POLICY = {
  schemaVersion: 1,
  mode: 'enforce',
  models: [{ client: 'pi' }],
  appliesWhenModelUnknown: true,
  hosts: { allow: ['github.com'], deny: [] },
};

let seq = 0;
const event = (orgId: string, installationId: string, type: string, payload: unknown, occurredAt: string) => ({
  eventId: `ev-${++seq}-${Math.random().toString(36).slice(2)}`,
  installationId,
  orgId,
  occurredAt,
  actor: { osUser: 'tester', gitName: null, gitEmail: `${installationId}@x` },
  type,
  payload,
});

describe.each<Backend>(['sqlite', 'postgres'])('hub airlock installations (%s)', (backend) => {
  let db: HubDb;
  let cookieAdmin: string;
  let cookieViewer: string;
  let cookieOrgB: string;
  let keyAlice: string;
  let keyBob: string;
  let keyOrgWide: string;
  let keyB: string;

  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  const post = (key: string, events: unknown[]) => supertest(__server).post('/v1/events').set(bearer(key)).send({ events });
  const applied = (key: string, inst: string, revision: number, iocRevision: number, at: string, org = 'org-a') =>
    post(key, [event(org, inst, 'airlock.policy-applied', { revision, iocRevision }, at)]);
  const refused = (key: string, inst: string, revision: number | null, error: string, at: string, iocRevision?: number) =>
    post(key, [event('org-a', inst, 'airlock.policy-refused', { revision, error, ...(iocRevision === undefined ? {} : { iocRevision }) }, at)]);
  const adminPut = (body: Record<string, unknown>, cookie = cookieAdmin) =>
    supertest(__server).put('/v1/admin/airlock').set('Cookie', cookie).send(body as any);
  const list = (cookie = cookieAdmin) => supertest(__server).get('/v1/admin/airlock/installations').set('Cookie', cookie);
  const history = (cookie = cookieAdmin) => supertest(__server).get('/v1/admin/airlock/history').set('Cookie', cookie);
  const row = (body: any, inst: string) => (body.installations as any[]).find(i => i.installationId === inst);

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
    // An admin-issued org-wide key: bound to no machine, so it speaks for none.
    keyOrgWide = await issueApiKey(db, 'org-a', 'ci');
    keyB = await issueApiKey(db, 'org-b', 'other-org', { installationId: 'inst-other' });
  });

  afterEach(async () => {
    await drainApp(__server);
    await db.close();
  });

  describe('an installation reports what it applied', () => {
    it('records the applied revision and when, per installation, against the current revision', async () => {
      await adminPut({ policy: POLICY });
      await adminPut({ policy: { ...POLICY, mode: 'observe' } });
      expect((await applied(keyAlice, 'inst-alice', 2, 0, '2026-01-27T10:00:00.000Z')).status).toBe(200);
      expect((await applied(keyBob, 'inst-bob', 1, 0, '2026-01-27T09:00:00.000Z')).status).toBe(200);

      const r = await list();
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.currentRevision).toBe(2);
      const alice = row(r.body, 'inst-alice');
      expect(alice).toMatchObject({ appliedRevision: 2, appliedIocRevision: 0, appliedAt: '2026-01-27T10:00:00.000Z', behind: false });
      expect(typeof alice.appliedRevision).toBe('number');
      expect(row(r.body, 'inst-bob')).toMatchObject({ appliedRevision: 1, behind: true });
    });

    it('an installation that never reported is listed with no applied revision, behind once a policy exists', async () => {
      await post(keyBob, [event('org-a', 'inst-bob', 'item.created', {}, '2026-01-27T08:00:00.000Z')]);
      expect(row((await list()).body, 'inst-bob')).toMatchObject({ appliedRevision: null, behind: false });
      await adminPut({ policy: POLICY });
      expect(row((await list()).body, 'inst-bob')).toMatchObject({ appliedRevision: null, behind: true });
    });

    it('an IOC list the installation has not applied yet is behind too', async () => {
      await adminPut({ policy: POLICY });
      await supertest(__server).put('/v1/admin/airlock/ioc').set('Cookie', cookieAdmin).send({ hosts: ['bad.example'] });
      await applied(keyAlice, 'inst-alice', 1, 0, '2026-01-27T10:00:00.000Z');
      const r = await list();
      expect(r.body.currentIocRevision).toBe(1);
      expect(row(r.body, 'inst-alice')).toMatchObject({ appliedRevision: 1, appliedIocRevision: 0, behind: true });
    });

    it('the same revision reported again keeps when it was first applied, and moves when it was last reported', async () => {
      await adminPut({ policy: POLICY });
      await applied(keyAlice, 'inst-alice', 1, 0, '2026-01-27T10:00:00.000Z');
      await applied(keyAlice, 'inst-alice', 1, 0, '2026-01-27T11:00:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({
        appliedRevision: 1, appliedAt: '2026-01-27T10:00:00.000Z', reportedAt: '2026-01-27T11:00:00.000Z',
      });
    });

    it('a report older than the stored one does not roll the revision back', async () => {
      await adminPut({ policy: POLICY });
      await adminPut({ policy: POLICY });
      await applied(keyAlice, 'inst-alice', 2, 0, '2026-01-27T11:00:00.000Z');
      await applied(keyAlice, 'inst-alice', 1, 0, '2026-01-27T10:00:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ appliedRevision: 2, appliedAt: '2026-01-27T11:00:00.000Z' });
    });

    it('reports dated in the future are rejected as such, in either order, and record nothing', async () => {
      await adminPut({ policy: POLICY });
      await adminPut({ policy: POLICY });
      const later = await applied(keyAlice, 'inst-alice', 2, 0, '2099-01-01T11:00:00.000Z');
      const earlier = await applied(keyAlice, 'inst-alice', 1, 0, '2099-01-01T10:00:00.000Z');
      const refusal = await refused(keyAlice, 'inst-alice', 2, 'invalid', '2099-01-01T12:00:00.000Z');
      for (const r of [later, earlier, refusal]) {
        expect(r.body.rejected).toBe(1);
        expect(r.body.rejections).toEqual([expect.objectContaining({ reason: 'future_dated' })]);
      }
      expect(row((await list()).body, 'inst-alice')).toBeUndefined();
      // A report as the clock allows lands afterwards, unblocked by them.
      await applied(keyAlice, 'inst-alice', 2, 0, '2026-01-27T10:00:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ appliedRevision: 2, refusedRevision: null });
    });

    it('a report dated within the allowed clock skew is recorded as sent', async () => {
      await adminPut({ policy: POLICY });
      const ahead = new Date(Math.floor(Date.now() / 1000) * 1000 + 2 * 60 * 1000);
      const sent = ahead.toISOString().replace('.000Z', '+00:00');
      const r = await applied(keyAlice, 'inst-alice', 1, 0, sent);
      expect(r.body.rejected).toBe(0);
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ appliedRevision: 1, appliedAt: ahead.toISOString() });
    });

    it('report times written with an offset are ordered as the instants they are', async () => {
      await adminPut({ policy: POLICY });
      await adminPut({ policy: POLICY });
      await applied(keyAlice, 'inst-alice', 2, 0, '2026-01-27T11:00:00Z');
      // 10:00 UTC, though its text sorts after 11:00Z.
      await applied(keyAlice, 'inst-alice', 1, 0, '2026-01-27T12:00:00+02:00');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ appliedRevision: 2, appliedAt: '2026-01-27T11:00:00.000Z' });
    });

    it('a report with no whole-number revision is not recorded', async () => {
      await adminPut({ policy: POLICY });
      await post(keyAlice, [event('org-a', 'inst-alice', 'airlock.policy-applied', { revision: 'two', iocRevision: 0 }, '2026-01-27T10:00:00.000Z')]);
      await post(keyAlice, [event('org-a', 'inst-alice', 'airlock.policy-applied', { revision: -1, iocRevision: 0 }, '2026-01-27T10:01:00.000Z')]);
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ appliedRevision: null });
    });

    it('an org-wide key, bound to no machine, cannot report for one', async () => {
      await adminPut({ policy: POLICY });
      await post(keyBob, [event('org-a', 'inst-bob', 'item.created', {}, '2026-01-27T08:00:00.000Z')]);
      await applied(keyOrgWide, 'inst-bob', 1, 0, '2026-01-27T10:00:00.000Z');
      expect(row((await list()).body, 'inst-bob')).toMatchObject({ appliedRevision: null, behind: true });
    });

    it("a key cannot report for another installation of its org", async () => {
      await adminPut({ policy: POLICY });
      await post(keyBob, [event('org-a', 'inst-bob', 'item.created', {}, '2026-01-27T08:00:00.000Z')]);
      await applied(keyAlice, 'inst-bob', 1, 0, '2026-01-27T10:00:00.000Z');
      expect(row((await list()).body, 'inst-bob')).toMatchObject({ appliedRevision: null });
    });
  });

  describe('a refused policy', () => {
    it('is recorded with its revision and reason, and leaves the applied revision as it was', async () => {
      await adminPut({ policy: POLICY });
      await adminPut({ policy: POLICY });
      await applied(keyAlice, 'inst-alice', 1, 0, '2026-01-27T10:00:00.000Z');
      await refused(keyAlice, 'inst-alice', 2, 'Hub returned an invalid Airlock policy: hosts.allow: bad', '2026-01-27T10:05:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({
        appliedRevision: 1, behind: true,
        refusedRevision: 2, refusedError: 'Hub returned an invalid Airlock policy: hosts.allow: bad', refusedAt: '2026-01-27T10:05:00.000Z',
      });
    });

    it('is cleared once the installation applies that revision or a later one', async () => {
      await adminPut({ policy: POLICY });
      await adminPut({ policy: POLICY });
      await adminPut({ policy: POLICY });
      await refused(keyAlice, 'inst-alice', 2, 'invalid', '2026-01-27T10:00:00.000Z');
      await applied(keyAlice, 'inst-alice', 1, 0, '2026-01-27T10:01:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ appliedRevision: 1, refusedRevision: 2 });
      await applied(keyAlice, 'inst-alice', 3, 0, '2026-01-27T10:02:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ appliedRevision: 3, refusedRevision: null, refusedError: null, behind: false });
    });

    it('a refusal delivered late, after an applied report of that revision or a later one, is ignored', async () => {
      await adminPut({ policy: POLICY });
      await adminPut({ policy: POLICY });
      await applied(keyAlice, 'inst-alice', 2, 0, '2026-01-27T10:05:00.000Z');
      await refused(keyAlice, 'inst-alice', 2, 'invalid', '2026-01-27T10:00:00.000Z');
      await refused(keyAlice, 'inst-alice', 1, 'invalid', '2026-01-27T10:01:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ appliedRevision: 2, refusedRevision: null, refusedError: null });
    });

    it('the same pair delivered in order: the refusal is cleared by the apply that followed it', async () => {
      await adminPut({ policy: POLICY });
      await adminPut({ policy: POLICY });
      await refused(keyAlice, 'inst-alice', 2, 'invalid', '2026-01-27T10:00:00.000Z');
      await applied(keyAlice, 'inst-alice', 2, 0, '2026-01-27T10:05:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ appliedRevision: 2, refusedRevision: null });
    });

    it('a refusal of a later revision than the one applied still lands, whatever its time', async () => {
      await adminPut({ policy: POLICY });
      await adminPut({ policy: POLICY });
      await adminPut({ policy: POLICY });
      await applied(keyAlice, 'inst-alice', 2, 0, '2026-01-27T10:00:00.000Z');
      await refused(keyAlice, 'inst-alice', 3, 'invalid', '2026-01-27T09:00:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ appliedRevision: 2, refusedRevision: 3, behind: true });
    });

    it('a refusal reported after the apply, of a revision it had applied, is still recorded', async () => {
      await adminPut({ policy: POLICY });
      await applied(keyAlice, 'inst-alice', 1, 0, '2026-01-27T10:00:00.000Z');
      await refused(keyAlice, 'inst-alice', 1, 'invalid', '2026-01-27T10:05:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ refusedRevision: 1 });
    });

    it('a refusal of a newer IOC list is not cleared by heartbeats of the IOC list still applied', async () => {
      await adminPut({ policy: POLICY });
      await applied(keyAlice, 'inst-alice', 1, 1, '2026-01-27T10:00:00.000Z');
      await refused(keyAlice, 'inst-alice', 1, 'invalid IOC list', '2026-01-27T10:01:00.000Z', 2);
      await applied(keyAlice, 'inst-alice', 1, 1, '2026-01-27T11:01:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ appliedIocRevision: 1, refusedRevision: 1, refusedIocRevision: 2 });
      await applied(keyAlice, 'inst-alice', 1, 2, '2026-01-27T11:30:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ appliedIocRevision: 2, refusedRevision: null, refusedIocRevision: null });
    });

    it('a refusal at the same instant as an apply is kept, covered or not; only a strictly later apply answers it', async () => {
      await adminPut({ policy: POLICY });
      await adminPut({ policy: POLICY });
      await applied(keyAlice, 'inst-alice', 2, 1, '2026-01-27T10:00:00.000Z');
      await refused(keyAlice, 'inst-alice', 2, 'invalid IOC list', '2026-01-27T10:00:00.000Z', 2);
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ refusedRevision: 2, refusedIocRevision: 2 });

      await applied(keyBob, 'inst-bob', 2, 2, '2026-01-27T10:00:00.000Z');
      await refused(keyBob, 'inst-bob', 2, 'invalid', '2026-01-27T10:00:00.000Z', 1);
      expect(row((await list()).body, 'inst-bob')).toMatchObject({ refusedRevision: 2, refusedIocRevision: 1 });
      await applied(keyBob, 'inst-bob', 2, 2, '2026-01-27T10:00:01.000Z');
      await refused(keyBob, 'inst-bob', 2, 'invalid', '2026-01-27T10:00:00.500Z', 1);
      expect(row((await list()).body, 'inst-bob')).toMatchObject({ refusedRevision: null });
    });

    it('the state kept and a refusal with no revision, sent in the same instant: the refusal is kept', async () => {
      await adminPut({ policy: POLICY });
      await adminPut({ policy: POLICY });
      await adminPut({ policy: POLICY });
      await applied(keyAlice, 'inst-alice', 3, 0, '2026-01-27T10:00:00.000Z');
      await refused(keyAlice, 'inst-alice', null, 'Hub returned a malformed Airlock answer', '2026-01-27T10:00:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({
        appliedRevision: 3, refusedRevision: null, refusedError: 'Hub returned a malformed Airlock answer',
      });
    });

    it('a refusal with no revision is never suppressed, even when it arrives after a later apply; a later apply still clears it', async () => {
      await adminPut({ policy: POLICY });
      await applied(keyAlice, 'inst-alice', 1, 0, '2026-01-27T10:05:00.000Z');
      await refused(keyAlice, 'inst-alice', null, 'malformed', '2026-01-27T10:00:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ refusedRevision: null, refusedError: 'malformed' });
      await applied(keyAlice, 'inst-alice', 1, 0, '2026-01-27T10:06:00.000Z');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ refusedError: null });
    });

    it('a very long reason is cut short', async () => {
      await refused(keyAlice, 'inst-alice', 1, 'x'.repeat(5000), '2026-01-27T10:00:00.000Z');
      const alice = row((await list()).body, 'inst-alice');
      expect(alice.refusedError.length).toBeLessThanOrEqual(500);
    });
  });

  describe('org isolation', () => {
    it("org B's admin sees only org B's installations and revision", async () => {
      await adminPut({ policy: POLICY });
      await applied(keyAlice, 'inst-alice', 1, 0, '2026-01-27T10:00:00.000Z');
      await applied(keyB, 'inst-other', 0, 0, '2026-01-27T10:00:00.000Z', 'org-b');
      const b = await list(cookieOrgB);
      expect(b.status).toBe(200);
      expect(b.body.currentRevision).toBe(0);
      expect(b.body.installations.map((i: any) => i.installationId)).toEqual(['inst-other']);
      expect((await list()).body.installations.map((i: any) => i.installationId)).not.toContain('inst-other');
    });

    it("org B's key cannot report for org A's installation", async () => {
      await adminPut({ policy: POLICY });
      await applied(keyAlice, 'inst-alice', 1, 0, '2026-01-27T10:00:00.000Z');
      await applied(keyB, 'inst-alice', 7, 0, '2026-01-27T11:00:00.000Z', 'org-b');
      expect(row((await list()).body, 'inst-alice')).toMatchObject({ appliedRevision: 1 });
    });

    it('an org rename carries the applied revisions along', () => {
      expect(ORG_ID_CHILD_TABLES).toContain('airlock_installations');
    });
  });

  describe('retired installations', () => {
    it('are not listed', async () => {
      await adminPut({ policy: POLICY });
      await applied(keyAlice, 'inst-alice', 1, 0, '2026-01-27T10:00:00.000Z');
      await db.run("UPDATE installations SET retired_at = '2026-01-27T12:00:00.000Z' WHERE id = 'inst-alice'");
      expect(row((await list()).body, 'inst-alice')).toBeUndefined();
    });
  });

  describe('the revision history', () => {
    async function waitForRows(n: number, cookie = cookieAdmin): Promise<any[]> {
      const deadline = Date.now() + 3000;
      for (;;) {
        const entries = (await history(cookie)).body.entries ?? [];
        if (entries.length >= n || Date.now() > deadline) return entries;
        await new Promise(res => setTimeout(res, 20));
      }
    }

    it("lists the org's Airlock changes newest first: who, when, and the revision before and after", async () => {
      await adminPut({ policy: POLICY });
      await adminPut({ policy: { ...POLICY, mode: 'observe' } });
      await supertest(__server).put('/v1/admin/airlock/ioc').set('Cookie', cookieAdmin).send({ hosts: ['bad.example'] });
      const entries = await waitForRows(3);
      expect(entries).toHaveLength(3);
      expect(entries.map(e => e.action)).toEqual(['airlock.ioc', 'airlock.update', 'airlock.update']);
      expect(entries[0]).toMatchObject({ actorEmail: ADMIN, before: { revision: 2, iocRevision: 0 }, after: { revision: 2, iocRevision: 1 } });
      expect(entries[1]).toMatchObject({ actorEmail: ADMIN, before: { revision: 1, iocRevision: 0 }, after: { revision: 2, iocRevision: 0 } });
      expect(entries[2]).toMatchObject({ before: null, after: { revision: 1, iocRevision: 0 } });
      expect(typeof entries[0].at).toBe('string');
    });

    it('carries no other settings area and no policy body', async () => {
      await adminPut({ policy: POLICY });
      await db.run(
        `INSERT INTO config_audit (id, org_id, at, actor_user_id, actor_email, source, ip, area, action, target, before_json, after_json, link)
         VALUES ('x-1', 'org-a', '2099-01-01T00:00:00.000Z', NULL, 'admin@x', 'board', NULL, 'flows', 'flow.update', 'flow', NULL, NULL, NULL)`,
      );
      const entries = await waitForRows(1);
      expect(entries.map(e => e.action)).toEqual(['airlock.update']);
      expect(entries[0].after.policy).toBeUndefined();
    });

    it("org B's admin sees none of org A's history", async () => {
      await adminPut({ policy: POLICY });
      await waitForRows(1);
      expect((await history(cookieOrgB)).body.entries).toEqual([]);
    });
  });

  describe('who may read them', () => {
    it('an api key is refused on both routes', async () => {
      expect((await supertest(__server).get('/v1/admin/airlock/installations').set(bearer(keyAlice))).status).toBe(401);
      expect((await supertest(__server).get('/v1/admin/airlock/history').set(bearer(keyAlice))).status).toBe(401);
    });

    it('a viewer is refused on both routes', async () => {
      expect((await list(cookieViewer)).status).toBe(403);
      expect((await history(cookieViewer)).status).toBe(403);
    });
  });
});
