// The child's side of federation (CGLAB-181, task 4): joining a parent,
// asking to be released, and leaving.
//
// The rule the user set: a child hub may NOT let itself out. Leaving is
// something the parent grants, so the roster at the parent stays authoritative
// and a child cannot quietly vanish from a dispatch target list.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { readParentBinding, writeParentBinding } from '../services/federation/parentBinding';
import { enqueueOutbox } from '../services/federation/federationSync';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-fed-join-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const PARENT = 'https://parent.example.com';
const TOKEN = 'fed_' + 'f'.repeat(64);

describe('child hub: join, request release, leave', () => {
  let app: any;
  let ctx: any;
  let adminCookie: string;
  let viewerCookie: string;
  let enrollCalls: any[];

  beforeEach(async () => {
    cleanup();
    enrollCalls = [];
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org',
      // Injected so the join route is testable without a parent on the network.
      federationClient: {
        async enroll(args: any) {
          enrollCalls.push(args);
          return { token: TOKEN, childHubId: 'ch-1', orgId: 'group', parentUrl: args.parentUrl };
        },
        async requestRelease(args: any) { enrollCalls.push({ release: args }); return { ok: true }; },
      },
    } as any);
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org', 'viewer@x', 'longenough1', 'viewer');
    adminCookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    viewerCookie = (await supertest(app).post('/auth/login').send({ email: 'viewer@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => {
    ctx.stopWorkers?.();
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  const join = (body: unknown, cookie = adminCookie) =>
    supertest(app).post('/v1/admin/federation/join').set('Cookie', cookie).send(body as any);

  describe('POST /v1/admin/federation/join', () => {
    it('requires an admin session', async () => {
      expect((await supertest(app).post('/v1/admin/federation/join').send({ parentUrl: PARENT, inviteToken: 't' })).status).toBe(401);
      expect((await join({ parentUrl: PARENT, inviteToken: 't' }, viewerCookie)).status).toBe(403);
      expect(await readParentBinding(ctx.db, SECRET)).toBeNull();
    });

    it('redeems the invite against the parent and stores the binding', async () => {
      const r = await join({ parentUrl: PARENT, inviteToken: 'body.sig' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ parentUrl: PARENT, childHubId: 'ch-1', state: 'active' });
      expect(enrollCalls[0]).toMatchObject({ parentUrl: PARENT, inviteToken: 'body.sig' });
      const b = await readParentBinding(ctx.db, SECRET);
      expect(b).toMatchObject({ parentUrl: PARENT, token: TOKEN, childHubId: 'ch-1', state: 'active' });
    });

    it('adopts the identity policy the parent hands back at enrolment', async () => {
      // Otherwise the first minute of a child's life in an opted-out group
      // forwards real identities.
      const out = await createHubApp({
        dbPath: TEST_DB + '4', secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org',
        federationClient: {
          async enroll() { return { token: TOKEN, childHubId: 'ch-9', identityPolicy: 'pseudonymize' }; },
        },
      } as any);
      await createPasswordUser(out.ctx.db, 'org', 'a@x', 'longenough1', 'admin');
      const cookie = (await supertest(out.app).post('/auth/login').send({ email: 'a@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
      const r = await supertest(out.app).post('/v1/admin/federation/join').set('Cookie', cookie).send({ parentUrl: PARENT, inviteToken: 't' });
      expect(r.status).toBe(200);
      expect((await readParentBinding(out.ctx.db, SECRET))!.identityPolicy).toBe('pseudonymize');
      const status = await supertest(out.app).get('/v1/admin/federation').set('Cookie', cookie);
      // and the child's own admin can see what their people are subject to
      expect(status.body.identityPolicy).toBe('pseudonymize');
      out.ctx.stopWorkers?.();
      await drainApp(out.app);
      await out.ctx.db.close();
      for (const sfx of ['', '-wal', '-shm']) { const f = TEST_DB + '4' + sfx; if (fs.existsSync(f)) fs.unlinkSync(f); }
    });

    it('never returns the federation token to the browser', async () => {
      const r = await join({ parentUrl: PARENT, inviteToken: 'body.sig' });
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain(TOKEN);
      expect(JSON.stringify(r.body)).not.toMatch(/fed_/);
    });

    it('refuses a non-http parent URL', async () => {
      for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url']) {
        const r = await join({ parentUrl: bad, inviteToken: 't' });
        expect(r.status).toBe(400);
      }
      expect(enrollCalls).toHaveLength(0);
      expect(await readParentBinding(ctx.db, SECRET)).toBeNull();
    });

    it('refuses to enrol this hub with itself', async () => {
      const r = await supertest(app).post('/v1/admin/federation/join')
        .set('Cookie', adminCookie).set('Host', 'self.example.com')
        .send({ parentUrl: 'http://self.example.com', inviteToken: 't' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/itself|own/i);
      expect(enrollCalls).toHaveLength(0);
    });

    it('requires an invite token', async () => {
      expect((await join({ parentUrl: PARENT })).status).toBe(400);
      expect(enrollCalls).toHaveLength(0);
    });

    it('refuses to join a second parent while already bound', async () => {
      expect((await join({ parentUrl: PARENT, inviteToken: 't' })).status).toBe(200);
      const second = await join({ parentUrl: 'https://other.example.com', inviteToken: 't2' });
      expect(second.status).toBe(409);
      expect((await readParentBinding(ctx.db, SECRET))!.parentUrl).toBe(PARENT);
    });

    it('surfaces the parent refusing the invite, and stores nothing', async () => {
      const out = await createHubApp({
        dbPath: TEST_DB + '2', secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org',
        federationClient: { async enroll() { throw Object.assign(new Error('invite token already used'), { response: { status: 400, data: { error: 'invite token already used' } } }); } },
      } as any);
      await createPasswordUser(out.ctx.db, 'org', 'a@x', 'longenough1', 'admin');
      const cookie = (await supertest(out.app).post('/auth/login').send({ email: 'a@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
      const r = await supertest(out.app).post('/v1/admin/federation/join').set('Cookie', cookie).send({ parentUrl: PARENT, inviteToken: 'used' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/already used/i);
      expect(await readParentBinding(out.ctx.db, SECRET)).toBeNull();
      out.ctx.stopWorkers?.();
      await drainApp(out.app);
      await out.ctx.db.close();
      for (const s of ['', '-wal', '-shm']) { const f = TEST_DB + '2' + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    });
  });

  describe('GET /v1/admin/federation', () => {
    it('reports an unbound hub as unbound', async () => {
      const r = await supertest(app).get('/v1/admin/federation').set('Cookie', adminCookie);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ bound: false });
      expect(JSON.stringify(r.body)).not.toMatch(/fed_/);
    });

    it('reports the binding, outbox depth and release state, without the token', async () => {
      await join({ parentUrl: PARENT, inviteToken: 't' });
      await enqueueOutbox(ctx.db, 'event', { a: 1 });
      const r = await supertest(app).get('/v1/admin/federation').set('Cookie', adminCookie);
      expect(r.body).toMatchObject({
        bound: true, parentUrl: PARENT, childHubId: 'ch-1', state: 'active',
        outboxDepth: 1, releaseRequested: false, canLeave: false,
      });
      expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    });

    it('requires an admin session', async () => {
      expect((await supertest(app).get('/v1/admin/federation')).status).toBe(401);
      expect((await supertest(app).get('/v1/admin/federation').set('Cookie', viewerCookie)).status).toBe(403);
    });
  });

  describe('POST /v1/admin/federation/release-request', () => {
    it('asks the parent to release this hub', async () => {
      await join({ parentUrl: PARENT, inviteToken: 't' });
      const r = await supertest(app).post('/v1/admin/federation/release-request')
        .set('Cookie', adminCookie).send({ reason: 'splitting off' });
      expect(r.status).toBe(200);
      expect(enrollCalls.some((c: any) => c.release?.reason === 'splitting off')).toBe(true);
      const status = await supertest(app).get('/v1/admin/federation').set('Cookie', adminCookie);
      expect(status.body.releaseRequested).toBe(true);
    });

    it('leaves the local flag alone when the parent refuses the request', async () => {
      // Setting it first stranded the admin: the UI hides the reason field on
      // this flag, so a failed request showed "waiting for the parent" forever
      // with no way to ask again.
      const out = await createHubApp({
        dbPath: TEST_DB + '3', secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org',
        federationClient: {
          async enroll() { return { token: TOKEN, childHubId: 'ch-9' }; },
          async requestRelease() { throw Object.assign(new Error('nope'), { response: { status: 503 } }); },
        },
      } as any);
      await createPasswordUser(out.ctx.db, 'org', 'a@x', 'longenough1', 'admin');
      const cookie = (await supertest(out.app).post('/auth/login').send({ email: 'a@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
      await supertest(out.app).post('/v1/admin/federation/join').set('Cookie', cookie).send({ parentUrl: PARENT, inviteToken: 't' });
      const bad = await supertest(out.app).post('/v1/admin/federation/release-request').set('Cookie', cookie).send({ reason: 'please' });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      const status = await supertest(out.app).get('/v1/admin/federation').set('Cookie', cookie);
      expect(status.body.releaseRequested).toBe(false);
      out.ctx.stopWorkers?.();
      await drainApp(out.app);
      await out.ctx.db.close();
      for (const sfx of ['', '-wal', '-shm']) { const f = TEST_DB + '3' + sfx; if (fs.existsSync(f)) fs.unlinkSync(f); }
    });

    it('is refused once the hub has already been released', async () => {
      await join({ parentUrl: PARENT, inviteToken: 't' });
      const current = (await readParentBinding(ctx.db, SECRET))!;
      await writeParentBinding(ctx.db, SECRET, { ...current, state: 'revoked' });
      const r = await supertest(app).post('/v1/admin/federation/release-request').set('Cookie', adminCookie).send({});
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/already been released/i);
    });

    it('is refused when the hub has no parent', async () => {
      expect((await supertest(app).post('/v1/admin/federation/release-request').set('Cookie', adminCookie).send({})).status).toBe(409);
    });

    it('requires an admin session', async () => {
      await join({ parentUrl: PARENT, inviteToken: 't' });
      expect((await supertest(app).post('/v1/admin/federation/release-request').send({})).status).toBe(401);
      expect((await supertest(app).post('/v1/admin/federation/release-request').set('Cookie', viewerCookie).send({})).status).toBe(403);
    });
  });

  describe('DELETE /v1/admin/federation — leaving is the parent\'s to grant', () => {
    it('refuses while the hub is still bound, and keeps the binding', async () => {
      await join({ parentUrl: PARENT, inviteToken: 't' });
      const r = await supertest(app).delete('/v1/admin/federation').set('Cookie', adminCookie);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/parent/i);
      expect((await readParentBinding(ctx.db, SECRET))!.state).toBe('active');
    });

    it('refuses even right after a release has been requested — asking is not being released', async () => {
      await join({ parentUrl: PARENT, inviteToken: 't' });
      await supertest(app).post('/v1/admin/federation/release-request').set('Cookie', adminCookie).send({});
      // The flag the UI disables Leave on must not flip merely because we asked.
      const status = await supertest(app).get('/v1/admin/federation').set('Cookie', adminCookie);
      expect(status.body).toMatchObject({ releaseRequested: true, canLeave: false, state: 'active' });
      const r = await supertest(app).delete('/v1/admin/federation').set('Cookie', adminCookie);
      expect(r.status).toBe(409);
      expect(await readParentBinding(ctx.db, SECRET)).not.toBeNull();
    });

    it('cannot be escaped by rotating AGENFK_HUB_SECRET_KEY', async () => {
      // The route used to read the binding with the key and treat "cannot
      // decrypt" as "no parent", clearing it. That made a key rotation a
      // product-surface way out of the group. Whether the parent has released
      // this hub is stored in clear precisely so it does not need the key.
      await join({ parentUrl: PARENT, inviteToken: 't' });
      ctx.config.secretKey = 'b'.repeat(64);
      const status = await supertest(app).get('/v1/admin/federation').set('Cookie', adminCookie);
      expect(status.body).toMatchObject({ bound: true, unreadable: true });
      const r = await supertest(app).delete('/v1/admin/federation').set('Cookie', adminCookie);
      expect(r.status).toBe(409);
      // still bound under the original key
      ctx.config.secretKey = SECRET;
      expect((await readParentBinding(ctx.db, SECRET))!.state).toBe('active');
    });

    it('still lets a genuinely released hub leave under a rotated key', async () => {
      // The refusal above must not strand a hub the parent HAS let go.
      await join({ parentUrl: PARENT, inviteToken: 't' });
      const current = (await readParentBinding(ctx.db, SECRET))!;
      await writeParentBinding(ctx.db, SECRET, { ...current, state: 'revoked' });
      ctx.config.secretKey = 'b'.repeat(64);
      const r = await supertest(app).delete('/v1/admin/federation').set('Cookie', adminCookie);
      expect(r.status).toBe(200);
      ctx.config.secretKey = SECRET;
      expect(await readParentBinding(ctx.db, SECRET)).toBeNull();
    });

    it('succeeds once the parent has released the hub', async () => {
      await join({ parentUrl: PARENT, inviteToken: 't' });
      // What the parent detaching looks like from here: the worker's next call
      // is refused and the binding is marked revoked.
      const current = (await readParentBinding(ctx.db, SECRET))!;
      await writeParentBinding(ctx.db, SECRET, { ...current, state: 'revoked' });
      const before = await supertest(app).get('/v1/admin/federation').set('Cookie', adminCookie);
      expect(before.body.canLeave).toBe(true);
      const r = await supertest(app).delete('/v1/admin/federation').set('Cookie', adminCookie);
      expect(r.status).toBe(200);
      expect(await readParentBinding(ctx.db, SECRET)).toBeNull();
    });

    it('does not carry a stale release request into the next group', async () => {
      await join({ parentUrl: PARENT, inviteToken: 't' });
      await supertest(app).post('/v1/admin/federation/release-request').set('Cookie', adminCookie).send({});
      const current = (await readParentBinding(ctx.db, SECRET))!;
      await writeParentBinding(ctx.db, SECRET, { ...current, state: 'revoked' });
      await supertest(app).delete('/v1/admin/federation').set('Cookie', adminCookie);
      await join({ parentUrl: 'https://another.example.com', inviteToken: 't2' });
      const status = await supertest(app).get('/v1/admin/federation').set('Cookie', adminCookie);
      // a freshly joined hub must not show as already waiting to be let go
      expect(status.body).toMatchObject({ bound: true, releaseRequested: false, canLeave: false });
    });

    it('is a no-op rather than an error on a hub that never had a parent', async () => {
      const r = await supertest(app).delete('/v1/admin/federation').set('Cookie', adminCookie);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ bound: false });
    });

    it('requires an admin session', async () => {
      await join({ parentUrl: PARENT, inviteToken: 't' });
      const current = (await readParentBinding(ctx.db, SECRET))!;
      await writeParentBinding(ctx.db, SECRET, { ...current, state: 'revoked' });
      expect((await supertest(app).delete('/v1/admin/federation')).status).toBe(401);
      expect((await supertest(app).delete('/v1/admin/federation').set('Cookie', viewerCookie)).status).toBe(403);
      expect(await readParentBinding(ctx.db, SECRET)).not.toBeNull();
    });

    it('leaves the queued outbox behind rather than silently discarding it', async () => {
      await join({ parentUrl: PARENT, inviteToken: 't' });
      await enqueueOutbox(ctx.db, 'event', { a: 1 });
      const current = (await readParentBinding(ctx.db, SECRET))!;
      await writeParentBinding(ctx.db, SECRET, { ...current, state: 'revoked' });
      await supertest(app).delete('/v1/admin/federation').set('Cookie', adminCookie);
      const r = await supertest(app).get('/v1/admin/federation').set('Cookie', adminCookie);
      expect(r.body.bound).toBe(false);
      expect(r.body.outboxDepth).toBe(1);
    });
  });
});
