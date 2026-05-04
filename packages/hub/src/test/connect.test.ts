import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-connect-test-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('hub plug-and-play onboarding', () => {
  let app: any;
  let ctx: any;
  let cookie: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookie = login.headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  describe('device-code login', () => {
    it('start returns a deviceCode + userCode + verificationUri (no auth needed)', async () => {
      const r = await supertest(app).post('/hub/device/start').send({});
      expect(r.status).toBe(200);
      expect(typeof r.body.deviceCode).toBe('string');
      expect(r.body.deviceCode.length).toBeGreaterThan(20);
      expect(typeof r.body.userCode).toBe('string');
      expect(r.body.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(typeof r.body.verificationUri).toBe('string');
      expect(r.body.verificationUri).toContain('/connect');
      expect(typeof r.body.expiresIn).toBe('number');
      expect(typeof r.body.interval).toBe('number');
    });

    it('poll returns pending for an unapproved code', async () => {
      const start = await supertest(app).post('/hub/device/start').send({});
      const r = await supertest(app).post('/hub/device/poll').send({ deviceCode: start.body.deviceCode });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('pending');
    });

    it('approve requires session', async () => {
      const start = await supertest(app).post('/hub/device/start').send({});
      const r = await supertest(app).post('/hub/device/approve').send({ userCode: start.body.userCode });
      expect(r.status).toBe(401);
    });

    it('approve binds the orgId, then poll returns the installation token', async () => {
      const start = await supertest(app).post('/hub/device/start').send({});
      const approve = await supertest(app)
        .post('/hub/device/approve')
        .set('Cookie', cookie)
        .send({ userCode: start.body.userCode });
      expect(approve.status).toBe(200);

      const poll = await supertest(app).post('/hub/device/poll').send({ deviceCode: start.body.deviceCode });
      expect(poll.status).toBe(200);
      expect(poll.body.status).toBe('approved');
      expect(typeof poll.body.token).toBe('string');
      expect(poll.body.token.length).toBeGreaterThan(20);
      expect(poll.body.orgId).toBe('org');
    });

    it('approve with an unknown userCode returns 404', async () => {
      const r = await supertest(app)
        .post('/hub/device/approve')
        .set('Cookie', cookie)
        .send({ userCode: 'ZZZZ-ZZZZ' });
      expect(r.status).toBe(404);
    });

    it('poll with an unknown deviceCode returns 404', async () => {
      const r = await supertest(app).post('/hub/device/poll').send({ deviceCode: 'nope' });
      expect(r.status).toBe(404);
    });
  });

  describe('magic-link invite', () => {
    it('create requires admin session', async () => {
      const r = await supertest(app).post('/hub/invite/create').send({});
      expect(r.status).toBe(401);
    });

    it('admin creates an invite with a join command and signed token', async () => {
      const r = await supertest(app).post('/hub/invite/create').set('Cookie', cookie).send({});
      expect(r.status).toBe(200);
      expect(typeof r.body.inviteToken).toBe('string');
      expect(r.body.inviteToken.length).toBeGreaterThan(40);
      expect(typeof r.body.joinCommand).toBe('string');
      expect(r.body.joinCommand).toMatch(/agenfk hub join /);
      expect(typeof r.body.expiresAt).toBe('string');
    });

    it('redeem trades a valid invite for an installation token', async () => {
      const created = await supertest(app).post('/hub/invite/create').set('Cookie', cookie).send({});
      const r = await supertest(app).post('/hub/invite/redeem').send({ inviteToken: created.body.inviteToken });
      expect(r.status).toBe(200);
      expect(r.body.orgId).toBe('org');
      expect(typeof r.body.token).toBe('string');
      expect(r.body.token.length).toBeGreaterThan(20);
    });

    it('redeem rejects a re-used invite (single-use)', async () => {
      const created = await supertest(app).post('/hub/invite/create').set('Cookie', cookie).send({});
      const first = await supertest(app).post('/hub/invite/redeem').send({ inviteToken: created.body.inviteToken });
      expect(first.status).toBe(200);
      const second = await supertest(app).post('/hub/invite/redeem').send({ inviteToken: created.body.inviteToken });
      expect(second.status).toBe(400);
    });

    it('redeem rejects an obviously-tampered invite token', async () => {
      const created = await supertest(app).post('/hub/invite/create').set('Cookie', cookie).send({});
      const tampered = created.body.inviteToken.slice(0, -4) + 'AAAA';
      const r = await supertest(app).post('/hub/invite/redeem').send({ inviteToken: tampered });
      expect(r.status).toBe(400);
    });
  });
});
