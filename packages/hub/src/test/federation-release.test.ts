// Parent side of release (CGLAB-181, task 4). A child asks to be let go; the
// parent's existing detach is the approval. There is deliberately no separate
// approve verb and no second state machine.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-fed-release-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('parent hub: a child asking to be released', () => {
  let app: any;
  let ctx: any;
  let adminCookie: string;

  async function enroll(name: string) {
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', adminCookie).send({});
    const r = await supertest(app).post('/v1/federation/enroll').send({ inviteToken: inv.body.inviteToken, childHub: { name } });
    expect(r.status).toBe(200);
    return r.body as { token: string; childHubId: string };
  }

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    adminCookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => {
    ctx.stopWorkers?.();
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  it('records the request against the child that made it', async () => {
    const a = await enroll('alpha');
    const r = await supertest(app).post('/v1/federation/release-request')
      .set('Authorization', `Bearer ${a.token}`).send({ reason: 'splitting off' });
    expect(r.status).toBe(200);
    const row = await ctx.db.get('SELECT release_requested_at, release_reason FROM child_hubs WHERE id = ?', [a.childHubId]);
    expect(row.release_requested_at).toBeTruthy();
    expect(row.release_reason).toBe('splitting off');
  });

  it('needs a federation key — an admin session is not one, and neither is an installation key', async () => {
    const a = await enroll('alpha');
    expect((await supertest(app).post('/v1/federation/release-request').send({})).status).toBe(401);
    expect((await supertest(app).post('/v1/federation/release-request').set('Cookie', adminCookie).send({})).status).toBe(401);
    const row = await ctx.db.get('SELECT release_requested_at FROM child_hubs WHERE id = ?', [a.childHubId]);
    expect(row.release_requested_at).toBeNull();
  });

  it('a child cannot request release on another child\'s behalf', async () => {
    const a = await enroll('alpha');
    const b = await enroll('beta');
    await supertest(app).post('/v1/federation/release-request').set('Authorization', `Bearer ${a.token}`).send({});
    const other = await ctx.db.get('SELECT release_requested_at FROM child_hubs WHERE id = ?', [b.childHubId]);
    expect(other.release_requested_at).toBeNull();
  });

  it('does not let a request move the original timestamp, so the queue keeps its order', async () => {
    const a = await enroll('alpha');
    await supertest(app).post('/v1/federation/release-request').set('Authorization', `Bearer ${a.token}`).send({ reason: 'first' });
    const first = (await ctx.db.get('SELECT release_requested_at FROM child_hubs WHERE id = ?', [a.childHubId])).release_requested_at;
    await supertest(app).post('/v1/federation/release-request').set('Authorization', `Bearer ${a.token}`).send({ reason: 'second' });
    const row = await ctx.db.get('SELECT release_requested_at, release_reason FROM child_hubs WHERE id = ?', [a.childHubId]);
    expect(new Date(row.release_requested_at).toISOString()).toBe(new Date(first).toISOString());
    // the newest reason wins, since that is what the admin should read
    expect(row.release_reason).toBe('second');
  });

  it('shows up on the admin roster so an admin can act on it', async () => {
    const a = await enroll('alpha');
    await enroll('beta');
    await supertest(app).post('/v1/federation/release-request').set('Authorization', `Bearer ${a.token}`).send({ reason: 'splitting off' });
    const list = await supertest(app).get('/v1/admin/child-hubs').set('Cookie', adminCookie);
    const byName = Object.fromEntries(list.body.childHubs.map((c: any) => [c.name, c]));
    expect(byName.alpha).toMatchObject({ releaseRequested: true, releaseReason: 'splitting off' });
    expect(typeof byName.alpha.releaseRequestedAt).toBe('string');
    expect(byName.beta).toMatchObject({ releaseRequested: false, releaseReason: null });
  });

  it('detaching IS the approval: no separate verb, and the child is refused afterwards', async () => {
    const a = await enroll('alpha');
    await supertest(app).post('/v1/federation/release-request').set('Authorization', `Bearer ${a.token}`).send({});
    const det = await supertest(app).post(`/v1/admin/child-hubs/${a.childHubId}/detach`).set('Cookie', adminCookie).send({});
    expect(det.status).toBe(200);
    expect((await supertest(app).post('/v1/federation/ping').set('Authorization', `Bearer ${a.token}`).send({})).status).toBe(401);
    expect((await supertest(app).post('/v1/federation/release-request').set('Authorization', `Bearer ${a.token}`).send({})).status).toBe(401);
  });

  it('a rejected request is simply a request that stays open — nothing is auto-detached', async () => {
    const a = await enroll('alpha');
    await supertest(app).post('/v1/federation/release-request').set('Authorization', `Bearer ${a.token}`).send({});
    // asking does not detach anything by itself
    expect((await supertest(app).post('/v1/federation/ping').set('Authorization', `Bearer ${a.token}`).send({})).status).toBe(200);
    const row = await ctx.db.get('SELECT detached_at FROM child_hubs WHERE id = ?', [a.childHubId]);
    expect(row.detached_at).toBeNull();
  });
});
