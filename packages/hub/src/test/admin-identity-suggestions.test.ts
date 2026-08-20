// Identity-merge suggestions (task 2b7a391b).
//
//   GET /v1/admin/identity-suggestions — candidate merges the hub can infer
//   GET /v1/admin/user-keys/merges     — what has already been merged
//
// installation_id is immutable provenance, so an installation whose current
// git_email implies one user_key while its history carries another is a
// candidate. What the hub must NOT do is act on that alone: userKeyFor falls
// back to a bare osUser with no namespacing, so 'dev', 'ubuntu' and 'runner' are
// buckets rather than people. Merging a bucket into the first email seen would
// attribute one person's history to another, and there is no unmerge.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-identsug-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('identity-merge suggestions', () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;
  let cookieView: string;

  const install = (id: string, gitEmail: string | null, osUser = 'dev') =>
    ctx.db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
       VALUES (?, 'org-a', '2026-01-01T00:00:00Z', '2026-05-06T00:00:00Z', ?, null, ?)`,
      [id, osUser, gitEmail],
    );

  const event = (id: string, installationId: string, userKey: string, day = '2026-02-01') =>
    ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
       VALUES (?, 'org-a', ?, ?, ?, ?, 'item.created', '{}')`,
      [id, installationId, userKey, `${day}T09:00:00Z`, `${day}T09:00:00Z`],
    );

  const liveKey = (hash: string, installationId: string) =>
    ctx.db.run(
      `INSERT INTO api_keys (token_hash, org_id, label, installation_id) VALUES (?, 'org-a', 'k', ?)`,
      [hash, installationId],
    );

  const suggestions = (cookie = cookieAdmin) =>
    supertest(app).get('/v1/admin/identity-suggestions').set('Cookie', cookie);

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org-a', 'view@x', 'longenough1', 'viewer');
    cookieAdmin = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    cookieView = (await supertest(app).post('/auth/login').send({ email: 'view@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  describe('authz', () => {
    it('rejects unauthenticated and non-admin', async () => {
      expect((await supertest(app).get('/v1/admin/identity-suggestions')).status).toBe(401);
      expect((await suggestions(cookieView)).status).toBe(403);
    });
  });

  describe('detection', () => {
    it('suggests the phantom osUser identity of an install that now reports an email', async () => {
      await install('inst-1', 'guilherme@cglab.com', 'guilhermecarlossiqueira');
      await event('e1', 'inst-1', 'guilhermecarlossiqueira', '2026-01-10');
      await event('e2', 'inst-1', 'guilhermecarlossiqueira', '2026-02-20');
      await event('e3', 'inst-1', 'guilherme@cglab.com', '2026-03-01');

      const r = await suggestions();

      expect(r.status).toBe(200);
      expect(r.body).toHaveLength(1);
      expect(r.body[0]).toMatchObject({
        from: 'guilhermecarlossiqueira',
        to: 'guilherme@cglab.com',
        events: 2,
        confidence: 'unambiguous',
      });
      expect(r.body[0].firstSeen).toContain('2026-01-10');
      expect(r.body[0].lastSeen).toContain('2026-02-20');
      expect(r.body[0].installations).toEqual(['inst-1']);
    });

    it('suggests an email change too, not only username keys', async () => {
      await install('inst-1', 'new@cglab.com');
      await event('e1', 'inst-1', 'old@previous-employer.com');

      const r = await suggestions();

      expect(r.body[0]).toMatchObject({ from: 'old@previous-employer.com', to: 'new@cglab.com' });
    });

    it('says nothing when history already matches the current identity', async () => {
      await install('inst-1', 'dev@acme.com');
      await event('e1', 'inst-1', 'dev@acme.com');

      expect((await suggestions()).body).toEqual([]);
    });

    it('says nothing for an install that still has no git email', async () => {
      // Nothing to merge INTO yet — this is the attributed-by-username case,
      // fixed at the source rather than by a merge.
      await install('inst-1', null, 'someuser');
      await event('e1', 'inst-1', 'someuser');

      expect((await suggestions()).body).toEqual([]);
    });

    it('ignores case differences in the email', async () => {
      await install('inst-1', 'Dev@Acme.com');
      await event('e1', 'inst-1', 'dev@acme.com');

      expect((await suggestions()).body).toEqual([]);
    });

    it('does not leak suggestions across orgs', async () => {
      await ctx.db.run("INSERT INTO orgs (id, name) VALUES ('org-b', 'B')");
      await ctx.db.run(
        `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
         VALUES ('inst-b', 'org-b', '2026-01-01T00:00:00Z', '2026-05-06T00:00:00Z', 'dev', null, 'b@other.com')`,
      );
      await ctx.db.run(
        `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload)
         VALUES ('eb', 'org-b', 'inst-b', 'dev', '2026-02-01T09:00:00Z', '2026-02-01T09:00:00Z', 'item.created', '{}')`,
      );

      expect((await suggestions()).body).toEqual([]);
    });
  });

  describe('conflation is never presented as one click', () => {
    it('marks a key produced by several installations as conflated', async () => {
      // The bare-osUser bucket: two people are both 'dev' on their own laptops,
      // so merging into either address would steal the other's history.
      await install('inst-1', 'alice@cglab.com', 'dev');
      await install('inst-2', 'bob@cglab.com', 'dev');
      await event('e1', 'inst-1', 'dev');
      await event('e2', 'inst-2', 'dev');

      const r = await suggestions();

      for (const s of r.body) {
        expect(s.confidence).toBe('conflated');
        expect(s.installations.length).toBeGreaterThan(0);
      }
      expect(r.body.map((s: any) => s.to).sort()).toEqual(['alice@cglab.com', 'bob@cglab.com']);
    });

    it('reports the per-installation breakdown for a conflated key', async () => {
      await install('inst-1', 'alice@cglab.com', 'dev');
      await install('inst-2', 'bob@cglab.com', 'dev');
      await event('e1', 'inst-1', 'dev');
      await event('e2', 'inst-2', 'dev');
      await event('e3', 'inst-2', 'dev');

      const r = await suggestions();
      const bob = r.body.find((s: any) => s.to === 'bob@cglab.com');

      expect(bob.events).toBe(2);
      expect(bob.sourceInstallationCount).toBe(2);
    });

    it('keeps unambiguous and conflated candidates distinguishable in one response', async () => {
      await install('inst-1', 'alice@cglab.com', 'dev');
      await install('inst-2', 'bob@cglab.com', 'dev');
      await install('inst-3', 'carol@cglab.com', 'carolonly');
      await event('e1', 'inst-1', 'dev');
      await event('e2', 'inst-2', 'dev');
      await event('e3', 'inst-3', 'carolonly');

      const r = await suggestions();
      const carol = r.body.find((s: any) => s.to === 'carol@cglab.com');

      expect(carol.confidence).toBe('unambiguous');
      expect(r.body.filter((s: any) => s.confidence === 'conflated')).toHaveLength(2);
    });
  });

  describe('live-key blocking', () => {
    it('flags a suggestion whose source installation still holds a live key', async () => {
      // The merge endpoint 409s here; the UI must pre-empt that rather than
      // letting an admin discover it by failing.
      await install('inst-1', 'guilherme@cglab.com', 'gcs');
      await event('e1', 'inst-1', 'gcs');
      await liveKey('hash-live', 'inst-1');

      expect((await suggestions()).body[0].blockedByLiveKey).toBe(true);
    });

    it('does not flag it once the key is revoked', async () => {
      await install('inst-1', 'guilherme@cglab.com', 'gcs');
      await event('e1', 'inst-1', 'gcs');
      await liveKey('hash-live', 'inst-1');
      await ctx.db.run("UPDATE api_keys SET revoked_at = datetime('now') WHERE token_hash = 'hash-live'");

      expect((await suggestions()).body[0].blockedByLiveKey).toBe(false);
    });
  });

  describe('a completed merge stops being suggested', () => {
    it('disappears after the merge is applied', async () => {
      await install('inst-1', 'guilherme@cglab.com', 'gcs');
      await event('e1', 'inst-1', 'gcs');
      expect((await suggestions()).body).toHaveLength(1);

      const m = await supertest(app).post('/v1/admin/user-keys/merge')
        .set('Cookie', cookieAdmin).send({ from: 'gcs', to: 'guilherme@cglab.com' });
      expect(m.status).toBe(200);

      expect((await suggestions()).body).toEqual([]);
    });
  });

  describe('GET /v1/admin/user-keys/merges', () => {
    it('lists what has already been merged, newest first', async () => {
      await install('inst-1', 'guilherme@cglab.com', 'gcs');
      await event('e1', 'inst-1', 'gcs');
      await supertest(app).post('/v1/admin/user-keys/merge')
        .set('Cookie', cookieAdmin).send({ from: 'gcs', to: 'guilherme@cglab.com' });

      const r = await supertest(app).get('/v1/admin/user-keys/merges').set('Cookie', cookieAdmin);

      expect(r.status).toBe(200);
      expect(r.body).toHaveLength(1);
      expect(r.body[0]).toMatchObject({
        from: 'gcs',
        to: 'guilherme@cglab.com',
        eventsMoved: 1,
        mergedByEmail: 'admin@x',
      });
      expect(r.body[0].createdAt).toBeTruthy();
    });

    it('is empty before any merge, and org-scoped', async () => {
      expect((await supertest(app).get('/v1/admin/user-keys/merges').set('Cookie', cookieAdmin)).body).toEqual([]);
    });

    it('rejects a viewer', async () => {
      expect((await supertest(app).get('/v1/admin/user-keys/merges').set('Cookie', cookieView)).status).toBe(403);
    });
  });
});
