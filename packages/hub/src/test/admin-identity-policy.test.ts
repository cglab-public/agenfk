// Setting the identity policy (CGLAB-184). Without these routes the opt-out
// could only be enabled with a psql session, which is not a control anyone
// can operate or audit.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const DB = path.join(os.tmpdir(), `agenfk-hub-idpolicy-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };

describe('admin: identity policy', () => {
  let app: any; let ctx: any; let adminCookie: string; let viewerCookie: string;

  async function enroll(name: string) {
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', adminCookie).send({});
    const r = await supertest(app).post('/v1/federation/enroll').send({ inviteToken: inv.body.inviteToken, childHub: { name } });
    return r.body as { token: string; childHubId: string };
  }
  const read = () => supertest(app).get('/v1/admin/federation/identity-policy').set('Cookie', adminCookie);

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org', 'viewer@x', 'longenough1', 'viewer');
    adminCookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    viewerCookie = (await supertest(app).post('/auth/login').send({ email: 'viewer@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => { ctx.stopWorkers?.(); await drainApp(app); await ctx.db.close(); cleanup(); });

  it('starts at keep, because a group is usually one organisation', async () => {
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.body.groupPolicy).toBe('keep');
    expect(r.body.childHubs).toEqual([]);
  });

  it('sets the group policy, and every child follows it', async () => {
    const a = await enroll('alpha');
    await enroll('beta');
    expect((await supertest(app).put('/v1/admin/federation/identity-policy').set('Cookie', adminCookie).send({ policy: 'pseudonymize' })).status).toBe(200);
    const r = await read();
    expect(r.body.groupPolicy).toBe('pseudonymize');
    expect(r.body.childHubs.map((c: any) => c.effective)).toEqual(['pseudonymize', 'pseudonymize']);
    // and it reaches the child over the wire
    const ping = await supertest(app).post('/v1/federation/ping').set('Authorization', `Bearer ${a.token}`).send({});
    expect(ping.body.identityPolicy).toBe('pseudonymize');
  });

  it('lets one child override the group, in either direction', async () => {
    const a = await enroll('alpha');
    await enroll('beta');
    await supertest(app).put('/v1/admin/federation/identity-policy').set('Cookie', adminCookie).send({ policy: 'pseudonymize' });
    await supertest(app).put(`/v1/admin/child-hubs/${a.childHubId}/identity-policy`).set('Cookie', adminCookie).send({ policy: 'keep' });
    const r = await read();
    const byName = Object.fromEntries(r.body.childHubs.map((c: any) => [c.name, c]));
    expect(byName.alpha).toMatchObject({ policy: 'keep', effective: 'keep' });
    expect(byName.beta).toMatchObject({ policy: null, effective: 'pseudonymize' });
  });

  it('clears an override with null, so the child follows the group again', async () => {
    const a = await enroll('alpha');
    await supertest(app).put('/v1/admin/federation/identity-policy').set('Cookie', adminCookie).send({ policy: 'pseudonymize' });
    await supertest(app).put(`/v1/admin/child-hubs/${a.childHubId}/identity-policy`).set('Cookie', adminCookie).send({ policy: 'keep' });
    await supertest(app).put(`/v1/admin/child-hubs/${a.childHubId}/identity-policy`).set('Cookie', adminCookie).send({ policy: null });
    const r = await read();
    expect(r.body.childHubs[0]).toMatchObject({ policy: null, effective: 'pseudonymize' });
  });

  it('refuses a value that is neither policy', async () => {
    const a = await enroll('alpha');
    expect((await supertest(app).put('/v1/admin/federation/identity-policy').set('Cookie', adminCookie).send({ policy: 'anonymous-ish' })).status).toBe(400);
    expect((await supertest(app).put(`/v1/admin/child-hubs/${a.childHubId}/identity-policy`).set('Cookie', adminCookie).send({ policy: 'maybe' })).status).toBe(400);
    expect((await read()).body.groupPolicy).toBe('keep');
  });

  it('404s an unknown child hub', async () => {
    const a = await enroll('alpha');
    expect((await supertest(app).put(`/v1/admin/child-hubs/${a.childHubId}/identity-policy`).set('Cookie', adminCookie).send({ policy: 'keep' })).status).toBe(200);
    expect((await supertest(app).put('/v1/admin/child-hubs/nope/identity-policy').set('Cookie', adminCookie).send({ policy: 'keep' })).status).toBe(404);
  });

  it('requires an admin session on every route', async () => {
    const a = await enroll('alpha');
    expect((await supertest(app).get('/v1/admin/federation/identity-policy')).status).toBe(401);
    expect((await supertest(app).get('/v1/admin/federation/identity-policy').set('Cookie', viewerCookie)).status).toBe(403);
    expect((await supertest(app).put('/v1/admin/federation/identity-policy').set('Cookie', viewerCookie).send({ policy: 'pseudonymize' })).status).toBe(403);
    expect((await supertest(app).put(`/v1/admin/child-hubs/${a.childHubId}/identity-policy`).set('Cookie', viewerCookie).send({ policy: 'pseudonymize' })).status).toBe(403);
    expect((await read()).body.groupPolicy).toBe('keep');
  });
});
