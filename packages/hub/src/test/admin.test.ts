import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { encryptSecret, decryptSecret } from '../crypto';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-admin-test-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64); // 64 hex chars = 32 bytes
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const loginAs = async (app: any, email: string, password: string) => {
  const r = await supertest(app).post('/auth/login').send({ email, password });
  return r.headers['set-cookie']?.[0] ?? '';
};

describe('crypto', () => {
  it('round-trips ciphertext', () => {
    const blob = encryptSecret('shhh', SECRET);
    expect(blob.startsWith('v1:')).toBe(true);
    expect(decryptSecret(blob, SECRET)).toBe('shhh');
  });
  it('rejects invalid key length', () => {
    expect(() => encryptSecret('x', 'short')).toThrow(/32 bytes/);
  });
  it('rejects tampered ciphertext (auth tag)', () => {
    const blob = encryptSecret('x', SECRET);
    const [, iv, , ct] = blob.split(':');
    const tampered = `v1:${iv}:${'00'.repeat(16)}:${ct}`;
    expect(() => decryptSecret(tampered, SECRET)).toThrow();
  });
});

describe('admin routes', () => {
  let app: any;
  let ctx: any;

  beforeEach(async () => {
    cleanup();
    const out = createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org',
    });
    app = out.app;
    ctx = out.ctx;
    createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    createPasswordUser(ctx.db, 'org', 'view@x', 'longenough1', 'viewer');
  });

  afterEach(() => { ctx.db.close(); cleanup(); });

  it('rejects non-admin sessions', async () => {
    const cookie = await loginAs(app, 'view@x', 'longenough1');
    const r = await supertest(app).get('/v1/admin/auth-config').set('Cookie', cookie);
    expect(r.status).toBe(403);
  });

  it('admin can read auth-config; secrets never echoed', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(app).get('/v1/admin/auth-config').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.passwordEnabled).toBe(true);
    expect(r.body.google.clientSecretSet).toBe(false);
  });

  it('PUT /auth-config encrypts client secrets at rest', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(app).put('/v1/admin/auth-config').set('Cookie', cookie).send({
      googleEnabled: true,
      google: { clientId: 'google-client', clientSecret: 'top-secret' },
      emailAllowlist: ['acme.com'],
    });
    expect(r.status).toBe(200);
    expect(r.body.google.clientSecretSet).toBe(true);

    const row = ctx.db.prepare('SELECT google_client_secret_enc FROM auth_config').get() as any;
    expect(row.google_client_secret_enc.startsWith('v1:')).toBe(true);
    expect(decryptSecret(row.google_client_secret_enc, SECRET)).toBe('top-secret');
  });

  it('issues api keys (raw token shown once) and lists them', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(app).post('/v1/admin/api-keys').set('Cookie', cookie).send({ label: 'laptop-a' });
    expect(r.status).toBe(201);
    expect(r.body.token.startsWith('agk_')).toBe(true);

    const list = await supertest(app).get('/v1/admin/api-keys').set('Cookie', cookie);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].label).toBe('laptop-a');
    expect(list.body[0].tokenHashPreview).toMatch(/^[0-9a-f]{8}$/);
  });

  it('revokes api keys via preview', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const issued = await supertest(app).post('/v1/admin/api-keys').set('Cookie', cookie).send({});
    const list = await supertest(app).get('/v1/admin/api-keys').set('Cookie', cookie);
    const preview = list.body[0].tokenHashPreview;
    const r = await supertest(app).delete(`/v1/admin/api-keys/${preview}`).set('Cookie', cookie);
    expect(r.body.revoked).toBe(1);
    const after = await supertest(app).get('/v1/admin/api-keys').set('Cookie', cookie);
    expect(after.body[0].revokedAt).not.toBeNull();
    void issued;
  });

  it('invites users and prevents duplicates', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const r = await supertest(app).post('/v1/admin/users/invite').set('Cookie', cookie)
      .send({ email: 'new@x', password: 'longenough1', role: 'viewer' });
    expect(r.status).toBe(201);
    const dup = await supertest(app).post('/v1/admin/users/invite').set('Cookie', cookie)
      .send({ email: 'new@x', password: 'longenough1', role: 'viewer' });
    expect(dup.status).toBe(409);
  });

  it('cannot delete self', async () => {
    const cookie = await loginAs(app, 'admin@x', 'longenough1');
    const me = await supertest(app).get('/auth/me').set('Cookie', cookie);
    const r = await supertest(app).delete(`/v1/admin/users/${me.body.userId}`).set('Cookie', cookie);
    expect(r.status).toBe(400);
  });
});
