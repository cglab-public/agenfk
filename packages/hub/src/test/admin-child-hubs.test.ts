// Story CGLAB-181, task 2 — parent-side administration of enrolled child hubs.
//
// Task 1 shipped the enforcement (a detached hub is refused on every federation
// route) but no way to reach it: detaching required a DBA with psql. These are
// the routes that make the credential revocable through the product.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-admin-child-hubs-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('admin: child hubs', () => {
  let app: any;
  let ctx: any;
  let adminCookie: string;
  let viewerCookie: string;

  async function enroll(name: string) {
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', adminCookie).send({});
    const r = await supertest(app).post('/v1/federation/enroll').send({
      inviteToken: inv.body.inviteToken, childHub: { name, hubVersion: '1.1.19' },
    });
    expect(r.status).toBe(200);
    return r.body as { token: string; childHubId: string };
  }

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org',
    });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org', 'viewer@x', 'longenough1', 'viewer');
    adminCookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    viewerCookie = (await supertest(app).post('/auth/login').send({ email: 'viewer@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => {
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  describe('GET /v1/admin/child-hubs', () => {
    it('requires an admin session', async () => {
      expect((await supertest(app).get('/v1/admin/child-hubs')).status).toBe(401);
      expect((await supertest(app).get('/v1/admin/child-hubs').set('Cookie', viewerCookie)).status).toBe(403);
    });

    it('is empty on a hub that has no child hubs, so a standalone hub shows nothing', async () => {
      const r = await supertest(app).get('/v1/admin/child-hubs').set('Cookie', adminCookie);
      expect(r.status).toBe(200);
      expect(r.body.childHubs).toEqual([]);
      expect(r.body.isParent).toBe(false);
    });

    it('lists enrolled child hubs newest-seen first, with identity and version', async () => {
      const a = await enroll('alpha');
      const b = await enroll('beta');
      await ctx.db.run("UPDATE child_hubs SET last_seen = '2020-01-01T00:00:00.000Z' WHERE id = ?", [a.childHubId]);
      const r = await supertest(app).get('/v1/admin/child-hubs').set('Cookie', adminCookie);
      expect(r.status).toBe(200);
      expect(r.body.isParent).toBe(true);
      expect(r.body.childHubs.map((c: any) => c.name)).toEqual(['beta', 'alpha']);
      const beta = r.body.childHubs.find((c: any) => c.id === b.childHubId);
      expect(beta).toMatchObject({ name: 'beta', hubVersion: '1.1.19', detached: false });
      expect(typeof beta.firstSeen).toBe('string');
      expect(typeof beta.lastSeen).toBe('string');
    });

    it('never exposes a token or token hash', async () => {
      const a = await enroll('alpha');
      const r = await supertest(app).get('/v1/admin/child-hubs').set('Cookie', adminCookie);
      // Assert the hub is actually THERE first — otherwise "no token in the
      // body" is satisfied by any error response.
      expect(r.status).toBe(200);
      expect(r.body.childHubs.map((c: any) => c.id)).toContain(a.childHubId);
      const blob = JSON.stringify(r.body);
      expect(blob).not.toMatch(/fed_/);
      expect(blob).not.toMatch(/token/i);
      expect(blob).not.toContain(a.token);
    });

    it('reports liveness from last_seen, so a silent child hub is visibly stale', async () => {
      const a = await enroll('alpha');
      const b = await enroll('beta');
      await ctx.db.run("UPDATE child_hubs SET last_seen = ? WHERE id = ?",
        [new Date(Date.now() - 72 * 3600_000).toISOString(), a.childHubId]);
      const r = await supertest(app).get('/v1/admin/child-hubs').set('Cookie', adminCookie);
      const byId = Object.fromEntries(r.body.childHubs.map((c: any) => [c.id, c]));
      expect(byId[a.childHubId].live).toBe(false);
      expect(byId[b.childHubId].live).toBe(true);
    });

    it('hides detached hubs by default and returns them flagged on request', async () => {
      const a = await enroll('alpha');
      await supertest(app).post(`/v1/admin/child-hubs/${a.childHubId}/detach`).set('Cookie', adminCookie).send({});
      const dflt = await supertest(app).get('/v1/admin/child-hubs').set('Cookie', adminCookie);
      expect(dflt.body.childHubs).toEqual([]);
      const all = await supertest(app).get('/v1/admin/child-hubs?includeDetached=1').set('Cookie', adminCookie);
      expect(all.body.childHubs).toHaveLength(1);
      expect(all.body.childHubs[0]).toMatchObject({ detached: true });
      expect(typeof all.body.childHubs[0].detachedAt).toBe('string');
    });

    it('still reports isParent after the last child hub is detached', async () => {
      // Otherwise the tab tells an admin "this hub has no child hubs" and
      // offers to enrol one, hiding the detached hub they just acted on.
      const a = await enroll('alpha');
      await supertest(app).post(`/v1/admin/child-hubs/${a.childHubId}/detach`).set('Cookie', adminCookie).send({});
      const r = await supertest(app).get('/v1/admin/child-hubs').set('Cookie', adminCookie);
      expect(r.body.childHubs).toEqual([]);
      expect(r.body.isParent).toBe(true);
    });

    it('does not leak child hubs across orgs', async () => {
      await enroll('alpha');
      await ctx.db.run("INSERT INTO orgs (id, name) VALUES ('other','other')");
      await ctx.db.run(
        "INSERT INTO child_hubs (id, org_id, name, first_seen, last_seen) VALUES ('x','other','not-yours', ?, ?)",
        [new Date().toISOString(), new Date().toISOString()],
      );
      const r = await supertest(app).get('/v1/admin/child-hubs').set('Cookie', adminCookie);
      expect(r.body.childHubs.map((c: any) => c.name)).toEqual(['alpha']);
    });
  });

  describe('PUT /v1/admin/child-hubs/:id', () => {
    it('renames a child hub, trimming the new name', async () => {
      const a = await enroll('alpha');
      const r = await supertest(app).put(`/v1/admin/child-hubs/${a.childHubId}`).set('Cookie', adminCookie).send({ name: '  renamed  ' });
      expect(r.status).toBe(200);
      expect(r.body.name).toBe('renamed');
      const row = await ctx.db.get('SELECT name FROM child_hubs WHERE id = ?', [a.childHubId]);
      expect(row.name).toBe('renamed');
    });

    it('rejects an empty or over-long name and 404s an unknown id', async () => {
      const a = await enroll('alpha');
      expect((await supertest(app).put(`/v1/admin/child-hubs/${a.childHubId}`).set('Cookie', adminCookie).send({ name: '   ' })).status).toBe(400);
      expect((await supertest(app).put(`/v1/admin/child-hubs/${a.childHubId}`).set('Cookie', adminCookie).send({ name: 'x'.repeat(121) })).status).toBe(400);
      expect((await supertest(app).put('/v1/admin/child-hubs/nope').set('Cookie', adminCookie).send({ name: 'ok' })).status).toBe(404);
      // the rejected writes left the original name alone
      const row = await ctx.db.get('SELECT name FROM child_hubs WHERE id = ?', [a.childHubId]);
      expect(row.name).toBe('alpha');
    });

    it('requires an admin session', async () => {
      const a = await enroll('alpha');
      expect((await supertest(app).put(`/v1/admin/child-hubs/${a.childHubId}`).send({ name: 'x' })).status).toBe(401);
      expect((await supertest(app).put(`/v1/admin/child-hubs/${a.childHubId}`).set('Cookie', viewerCookie).send({ name: 'x' })).status).toBe(403);
    });

    it('404s rather than claiming success when the row vanished mid-request', async () => {
      // The lookup and the write are two statements; a delete in between used
      // to yield a 200 for a rename that never happened, and the tab would show
      // the old name back on the next refresh with no explanation.
      const a = await enroll('alpha');
      const realRun = ctx.db.run.bind(ctx.db);
      ctx.db.run = async (sql: string, params?: unknown[]) => {
        if (/UPDATE child_hubs SET name/i.test(sql)) return { changes: 0 } as any;
        return realRun(sql, params);
      };
      const r = await supertest(app).put(`/v1/admin/child-hubs/${a.childHubId}`).set('Cookie', adminCookie).send({ name: 'ghost' });
      ctx.db.run = realRun;
      expect(r.status).toBe(404);
    });

    it('cannot rename a child hub belonging to another org', async () => {
      const mine = await enroll('alpha');
      await ctx.db.run("INSERT INTO orgs (id, name) VALUES ('other','other')");
      await ctx.db.run(
        "INSERT INTO child_hubs (id, org_id, name, first_seen, last_seen) VALUES ('x','other','not-yours', ?, ?)",
        [new Date().toISOString(), new Date().toISOString()],
      );
      // mine renames, so the 404 below is about the org, not the route
      expect((await supertest(app).put(`/v1/admin/child-hubs/${mine.childHubId}`).set('Cookie', adminCookie).send({ name: 'ok' })).status).toBe(200);
      expect((await supertest(app).put('/v1/admin/child-hubs/x').set('Cookie', adminCookie).send({ name: 'stolen' })).status).toBe(404);
      expect((await ctx.db.get("SELECT name FROM child_hubs WHERE id = 'x'")).name).toBe('not-yours');
    });
  });

  describe('POST /v1/admin/child-hubs/:id/detach', () => {
    it('marks the hub detached and revokes its federation keys in one go', async () => {
      const a = await enroll('alpha');
      const r = await supertest(app).post(`/v1/admin/child-hubs/${a.childHubId}/detach`).set('Cookie', adminCookie).send({});
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ id: a.childHubId, detached: true, revokedKeys: 1 });
      const row = await ctx.db.get('SELECT detached_at FROM child_hubs WHERE id = ?', [a.childHubId]);
      expect(row.detached_at).toBeTruthy();
      const key = await ctx.db.get('SELECT revoked_at FROM federation_keys WHERE child_hub_id = ?', [a.childHubId]);
      expect(key.revoked_at).toBeTruthy();
    });

    it('takes the child hub off the air immediately', async () => {
      const a = await enroll('alpha');
      expect((await supertest(app).post('/v1/federation/ping').set('Authorization', `Bearer ${a.token}`).send({})).status).toBe(200);
      await supertest(app).post(`/v1/admin/child-hubs/${a.childHubId}/detach`).set('Cookie', adminCookie).send({});
      expect((await supertest(app).post('/v1/federation/ping').set('Authorization', `Bearer ${a.token}`).send({})).status).toBe(401);
      expect((await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${a.token}`)).status).toBe(401);
    });

    it('is idempotent and keeps the original detached_at', async () => {
      const a = await enroll('alpha');
      const first = await supertest(app).post(`/v1/admin/child-hubs/${a.childHubId}/detach`).set('Cookie', adminCookie).send({});
      expect(first.body.detached).toBe(true);
      // Move the stored timestamp somewhere no clock can produce. Comparing two
      // live `new Date()` values let a re-detach that DOES reset the column pass
      // whenever both calls landed in the same millisecond.
      const MARKER = '2020-01-01T00:00:00.000Z';
      await ctx.db.run('UPDATE child_hubs SET detached_at = ? WHERE id = ?', [MARKER, a.childHubId]);
      const second = await supertest(app).post(`/v1/admin/child-hubs/${a.childHubId}/detach`).set('Cookie', adminCookie).send({});
      expect(second.status).toBe(200);
      expect(second.body.revokedKeys).toBe(0);
      const after = await ctx.db.get('SELECT detached_at FROM child_hubs WHERE id = ?', [a.childHubId]);
      expect(new Date(after.detached_at).toISOString()).toBe(MARKER);
      expect(second.body.detachedAt).toBe(MARKER);
    });

    it('records who detached the hub', async () => {
      const a = await enroll('alpha');
      const r = await supertest(app).post(`/v1/admin/child-hubs/${a.childHubId}/detach`).set('Cookie', adminCookie).send({});
      expect(r.body.detachedByEmail).toBe('admin@x');
      const row = await ctx.db.get('SELECT detached_by_email, detached_by_user_id FROM child_hubs WHERE id = ?', [a.childHubId]);
      expect(row.detached_by_email).toBe('admin@x');
      expect(row.detached_by_user_id).toBeTruthy();
    });

    it('404s an unknown id and one belonging to another org', async () => {
      await ctx.db.run("INSERT INTO orgs (id, name) VALUES ('other','other')");
      await ctx.db.run(
        "INSERT INTO child_hubs (id, org_id, name, first_seen, last_seen) VALUES ('x','other','not-yours', ?, ?)",
        [new Date().toISOString(), new Date().toISOString()],
      );
      // A hub of my own detaches, so the 404s below are about the id, not
      // about the route being absent.
      const mine = await enroll('mine');
      expect((await supertest(app).post(`/v1/admin/child-hubs/${mine.childHubId}/detach`).set('Cookie', adminCookie).send({})).status).toBe(200);
      expect((await supertest(app).post('/v1/admin/child-hubs/nope/detach').set('Cookie', adminCookie).send({})).status).toBe(404);
      expect((await supertest(app).post('/v1/admin/child-hubs/x/detach').set('Cookie', adminCookie).send({})).status).toBe(404);
      const row = await ctx.db.get("SELECT detached_at FROM child_hubs WHERE id = 'x'");
      expect(row.detached_at).toBeNull();
    });

    it('requires an admin session', async () => {
      const a = await enroll('alpha');
      expect((await supertest(app).post(`/v1/admin/child-hubs/${a.childHubId}/detach`).send({})).status).toBe(401);
      expect((await supertest(app).post(`/v1/admin/child-hubs/${a.childHubId}/detach`).set('Cookie', viewerCookie).send({})).status).toBe(403);
      const row = await ctx.db.get('SELECT detached_at FROM child_hubs WHERE id = ?', [a.childHubId]);
      expect(row.detached_at).toBeNull();
    });

    it('detaching one child hub leaves the others on the air', async () => {
      const a = await enroll('alpha');
      const b = await enroll('beta');
      const det = await supertest(app).post(`/v1/admin/child-hubs/${a.childHubId}/detach`).set('Cookie', adminCookie).send({});
      // The detach must have HAPPENED, or "beta still works" proves nothing.
      expect(det.status).toBe(200);
      expect((await supertest(app).post('/v1/federation/ping').set('Authorization', `Bearer ${a.token}`).send({})).status).toBe(401);
      expect((await supertest(app).post('/v1/federation/ping').set('Authorization', `Bearer ${b.token}`).send({})).status).toBe(200);
    });
  });

  describe('invite generation is reachable from the admin surface', () => {
    it('GET /v1/admin/child-hubs/invite mints a join token an admin can hand over', async () => {
      const r = await supertest(app).post('/v1/admin/child-hubs/invite').set('Cookie', adminCookie).send({});
      expect(r.status).toBe(200);
      expect(typeof r.body.inviteToken).toBe('string');
      expect(typeof r.body.parentUrl).toBe('string');
      expect(typeof r.body.expiresAt).toBe('string');
      // and it actually works
      const enrolled = await supertest(app).post('/v1/federation/enroll').send({
        inviteToken: r.body.inviteToken, childHub: { name: 'from-admin-tab' },
      });
      expect(enrolled.status).toBe(200);
    });

    it('requires an admin session', async () => {
      expect((await supertest(app).post('/v1/admin/child-hubs/invite')).status).toBe(401);
      expect((await supertest(app).post('/v1/admin/child-hubs/invite').set('Cookie', viewerCookie)).status).toBe(403);
    });
  });
});
