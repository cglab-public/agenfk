/**
 * Minting a key with no installation binding is how the production data broke
 * (BUG bb27c0aa): an admin typed a new member's email into the "create key"
 * form, and the key came back unbound. Such a key can ingest but can NEVER
 * receive a fleet directive (GET /v1/upgrade-directive returns 204 for an
 * unbound key), so those two machines were silently unreachable.
 *
 * The capability stays — a shared/CI key is legitimate — but the trap does not:
 * the response must say plainly that the key is unbound and what that costs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-mintguard-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('POST /v1/admin/api-keys warns when the key is not bound to an installation', () => {
  let app: any; let ctx: any; let cookie: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a',
    });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' }))
      .headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => {
    await drainApp(app);
    ctx.stopWorkers?.();
    await ctx.db.close();
    cleanup();
  });

  it('still issues the key, but flags it as unbound', async () => {
    const r = await supertest(app).post('/v1/admin/api-keys')
      .set('Cookie', cookie).send({ label: 'guilherme.siqueira@cglab.com' });

    expect(r.status).toBe(201);
    expect(typeof r.body.token).toBe('string');
    expect(r.body.unbound).toBe(true);
  });

  it('says what being unbound costs, not just that it happened', async () => {
    const r = await supertest(app).post('/v1/admin/api-keys')
      .set('Cookie', cookie).send({ label: 'diego.penha@cglab.com' });

    // The operator has to be able to act on this without reading the source.
    expect(r.body.warning).toMatch(/installation/i);
    expect(r.body.warning).toMatch(/fleet|directive/i);
  });

  it('points at the onboarding flow rather than promising automatic binding', async () => {
    // Only onboarding keys self-bind — they are the only ones known BY
    // CONSTRUCTION to belong to a single machine. A key minted here has no such
    // guarantee, so promising it "binds itself automatically" would be false.
    const r = await supertest(app).post('/v1/admin/api-keys')
      .set('Cookie', cookie).send({ label: 'someone@cglab.com' });

    expect(r.body.warning).toMatch(/hub join|hub login/);
    expect(r.body.warning).not.toMatch(/automatically/i);
  });

  it('refuses a label reserved for the onboarding flows', async () => {
    // Ingest binds an unbound key whose label marks it as one machine's
    // credential. If a caller could type such a label here, a SHARED key would
    // inherit that binding: the first machine to report would win and every
    // other machine on the key would be refused as foreign_installation.
    for (const label of ['device:ci-runner', 'invite:builds@cglab.com', 'invite', 'DEVICE:SHOUTY']) {
      const r = await supertest(app).post('/v1/admin/api-keys').set('Cookie', cookie).send({ label });
      expect(r.status, `label ${label}`).toBe(400);
      expect(r.body.token, `label ${label} must not mint a key`).toBeUndefined();
    }
  });
});
