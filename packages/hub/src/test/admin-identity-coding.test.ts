import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { listAudit } from '../services/configAudit';
import { drainApp } from './helpers/drainApp';

const DB = path.join(os.tmpdir(), `agenfk-hub-idcoding-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };

const AS_WRITTEN = { person: 'as-written', installation: 'as-written' };

describe('admin: identity coding', () => {
  let app: any; let ctx: any; let adminCookie: string; let viewerCookie: string;

  async function enroll(name: string) {
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', adminCookie).send({});
    const r = await supertest(app).post('/v1/federation/enroll').send({ inviteToken: inv.body.inviteToken, childHub: { name } });
    return r.body as { token: string; childHubId: string; identity: unknown; identityPolicy: unknown };
  }
  const read = () => supertest(app).get('/v1/admin/federation/identity').set('Cookie', adminCookie);
  const setGroup = (body: unknown) => supertest(app).put('/v1/admin/federation/identity').set('Cookie', adminCookie).send(body as object);
  const setChild = (id: string, body: unknown) => supertest(app).put(`/v1/admin/child-hubs/${id}/identity`).set('Cookie', adminCookie).send(body as object);
  const ping = (token: string) => supertest(app).post('/v1/federation/ping').set('Authorization', `Bearer ${token}`).send({});

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

  it('starts with both fields as written: nothing is coded until an admin says so', async () => {
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.body.group).toEqual({ person: null, installation: null });
    expect(r.body.effective).toEqual(AS_WRITTEN);
    expect(r.body.childHubs).toEqual([]);
  });

  it('sets the group default per field, and every child follows it, over the wire too', async () => {
    const a = await enroll('alpha');
    await enroll('beta');
    expect((await setGroup({ person: 'coded' })).status).toBe(200);
    const r = await read();
    expect(r.body.group).toEqual({ person: 'coded', installation: null });
    expect(r.body.effective).toEqual({ person: 'coded', installation: 'as-written' });
    expect(r.body.childHubs.map((c: any) => c.effective)).toEqual([
      { person: 'coded', installation: 'as-written' }, { person: 'coded', installation: 'as-written' },
    ]);
    const p = await ping(a.token);
    expect(p.body.identity).toEqual({ person: 'coded', installation: 'as-written' });
    expect(p.body.identityPolicy).toBe('pseudonymize');
  });

  it('changes only the fields a request names', async () => {
    await setGroup({ person: 'coded', installation: 'coded' });
    await setGroup({ installation: 'as-written' });
    expect((await read()).body.group).toEqual({ person: 'coded', installation: 'as-written' });
  });

  it('lets one child override each field of the group default, in either direction', async () => {
    const a = await enroll('alpha');
    const b = await enroll('beta');
    await setGroup({ person: 'coded' });
    expect((await setChild(a.childHubId, { person: 'as-written', installation: 'coded' })).status).toBe(200);
    const r = await read();
    const byName = Object.fromEntries(r.body.childHubs.map((c: any) => [c.name, c]));
    expect(byName.alpha).toMatchObject({
      override: { person: 'as-written', installation: 'coded' },
      effective: { person: 'as-written', installation: 'coded' },
    });
    expect(byName.beta).toMatchObject({
      override: { person: null, installation: null },
      effective: { person: 'coded', installation: 'as-written' },
    });
    expect((await ping(a.token)).body.identity).toEqual({ person: 'as-written', installation: 'coded' });
    expect((await ping(b.token)).body.identity).toEqual({ person: 'coded', installation: 'as-written' });
  });

  it('clears an override with null, so the child follows the group again for that field', async () => {
    const a = await enroll('alpha');
    await setGroup({ person: 'coded' });
    await setChild(a.childHubId, { person: 'as-written', installation: 'coded' });
    await setChild(a.childHubId, { person: null });
    const r = await read();
    expect(r.body.childHubs[0]).toMatchObject({
      override: { person: null, installation: 'coded' },
      effective: { person: 'coded', installation: 'coded' },
    });
  });

  it('hands the group default to a child at enrolment, not a minute later', async () => {
    await setGroup({ installation: 'coded' });
    const a = await enroll('alpha');
    expect(a.identity).toEqual({ person: 'as-written', installation: 'coded' });
    expect(a.identityPolicy).toBe('pseudonymize');
  });

  it('refuses a value that is neither as written nor coded, and a request that names no field', async () => {
    const a = await enroll('alpha');
    expect((await setGroup({ person: 'pseudonymize' })).status).toBe(400);
    expect((await setGroup({ person: null })).status).toBe(400);
    expect((await setGroup({})).status).toBe(400);
    expect((await setGroup({ policy: 'keep' })).status).toBe(400);
    expect((await setChild(a.childHubId, { installation: 'maybe' })).status).toBe(400);
    expect((await setChild(a.childHubId, {})).status).toBe(400);
    expect((await read()).body.group).toEqual({ person: null, installation: null });
    expect((await read()).body.childHubs[0].override).toEqual({ person: null, installation: null });
  });

  it('404s an unknown child hub', async () => {
    const a = await enroll('alpha');
    expect((await setChild(a.childHubId, { person: 'coded' })).status).toBe(200);
    expect((await setChild('nope', { person: 'coded' })).status).toBe(404);
  });

  it('records every change in the config audit, before -> after', async () => {
    const a = await enroll('alpha');
    await setGroup({ person: 'coded' });
    await setChild(a.childHubId, { installation: 'coded' });
    const rows = (await listAudit(ctx.db, 'org', { area: 'federation', limit: 50 })).rows;
    const group = rows.find(r => r.action === 'identity-coding.update');
    expect(group).toBeTruthy();
    expect(group!.before).toBeNull();
    expect(group!.after).toMatchObject({ identity_person: 'coded', identity_installation: null });
    const child = rows.find(r => r.action === 'child-hub.identity-coding');
    expect(child).toBeTruthy();
    expect(child!.target).toContain(a.childHubId);
    expect(child!.before).toMatchObject({ identity_person: null, identity_installation: null });
    expect(child!.after).toMatchObject({ identity_person: null, identity_installation: 'coded' });
  });

  it('serves no route under the old binary policy', async () => {
    const a = await enroll('alpha');
    expect((await supertest(app).get('/v1/admin/federation/identity-policy').set('Cookie', adminCookie)).status).toBe(404);
    expect((await supertest(app).put('/v1/admin/federation/identity-policy').set('Cookie', adminCookie).send({ policy: 'pseudonymize' })).status).toBe(404);
    expect((await supertest(app).put(`/v1/admin/child-hubs/${a.childHubId}/identity-policy`).set('Cookie', adminCookie).send({ policy: 'keep' })).status).toBe(404);
  });

  it('requires an admin session on every route', async () => {
    const a = await enroll('alpha');
    expect((await supertest(app).get('/v1/admin/federation/identity')).status).toBe(401);
    expect((await supertest(app).get('/v1/admin/federation/identity').set('Cookie', viewerCookie)).status).toBe(403);
    expect((await supertest(app).put('/v1/admin/federation/identity').set('Cookie', viewerCookie).send({ person: 'coded' })).status).toBe(403);
    expect((await supertest(app).put(`/v1/admin/child-hubs/${a.childHubId}/identity`).set('Cookie', viewerCookie).send({ person: 'coded' })).status).toBe(403);
    expect((await read()).body.group).toEqual({ person: null, installation: null });
  });
});
