// Device-code onboarding must bind the installation (BUG 159360db).
//
// Observed in production: an install onboarded with `agenfk hub login` showed no
// label on the fleet board and sat 'pending' for days while its bound peers
// upgraded. The device flow issued its api_key with no installation binding, and
// GET /v1/upgrade-directive returns 204 for an unbound key because it cannot be
// attributed to a machine — so such an install is structurally invisible to
// every fleet operation, not merely mislabelled.
//
// The identity travels on /device/start so the token can be bound when it is
// issued at approve time, and so an approving admin can see whose machine it is.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { hashToken } from '../auth/apiKey';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-devbind-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const IDENTITY = {
  installationId: 'inst-device-1',
  osUser: 'gcsiqueira',
  gitName: 'Guilherme Siqueira',
  gitEmail: 'guilherme@cglab.com',
};

describe('device-code onboarding binds the installation', () => {
  let app: any;
  let ctx: any;
  let cookie: string;

  const keyRow = (token: string) =>
    ctx.db.get(
      'SELECT installation_id, label, os_user, git_name, git_email FROM api_keys WHERE token_hash = ?',
      [hashToken(token)],
    );

  /** Walk the whole flow and hand back the issued token. */
  const onboard = async (identity: unknown) => {
    const start = await supertest(app).post('/hub/device/start').send(
      identity === undefined ? {} : { installation: identity },
    );
    expect(start.status).toBe(200);
    const approve = await supertest(app).post('/hub/device/approve')
      .set('Cookie', cookie).send({ userCode: start.body.userCode });
    expect(approve.status).toBe(200);
    const poll = await supertest(app).post('/hub/device/poll').send({ deviceCode: start.body.deviceCode });
    expect(poll.body.status).toBe('approved');
    return { token: poll.body.token as string, userCode: start.body.userCode as string };
  };

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookie = login.headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  it('binds the installation id onto the issued key', async () => {
    const { token } = await onboard(IDENTITY);

    expect((await keyRow(token)).installation_id).toBe('inst-device-1');
  });

  it('carries the git and os identity onto the key', async () => {
    const { token } = await onboard(IDENTITY);

    const row = await keyRow(token);
    expect(row.os_user).toBe('gcsiqueira');
    expect(row.git_name).toBe('Guilherme Siqueira');
    expect(row.git_email).toBe('guilherme@cglab.com');
  });

  it('labels the key by git email, matching the invite flow', async () => {
    const { token } = await onboard(IDENTITY);

    expect((await keyRow(token)).label).toBe('device:guilherme@cglab.com');
  });

  it('falls back to the os user when no git email is configured', async () => {
    const { token } = await onboard({ ...IDENTITY, gitEmail: null });

    expect((await keyRow(token)).label).toBe('device:gcsiqueira');
  });

  it('the bound install receives an upgrade directive', async () => {
    // The point of the whole fix: an unbound key gets 204 forever.
    const { token } = await onboard(IDENTITY);
    await ctx.db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
       VALUES ('inst-device-1', 'org-a', '2026-01-01T00:00:00Z', '2026-05-06T00:00:00Z', 'gcsiqueira', null, 'guilherme@cglab.com')`,
    );
    await ctx.db.run(
      `INSERT INTO upgrade_directives (id, org_id, target_version, scope_type, scope_id)
       VALUES ('dir-1', 'org-a', '1.2.3', 'installation', 'inst-device-1')`,
    );
    await ctx.db.run(
      `INSERT INTO upgrade_directive_targets (directive_id, installation_id, state)
       VALUES ('dir-1', 'inst-device-1', 'pending')`,
    );

    const r = await supertest(app).get('/v1/upgrade-directive').set('Authorization', `Bearer ${token}`);

    expect(r.status).toBe(200);
    expect(r.body.targetVersion).toBe('1.2.3');
  });

  it('still issues a working key when an older CLI sends no identity', async () => {
    // Backward compatibility: a fleet mid-upgrade must not be broken by this.
    const { token, userCode } = await onboard(undefined);

    const row = await keyRow(token);
    expect(row.installation_id).toBeNull();
    expect(row.label).toBe(`device:${userCode}`);
    // And the key still authenticates.
    expect((await supertest(app).get('/v1/ping').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });

  it('ignores non-string identity fields rather than storing junk', async () => {
    const { token } = await onboard({ installationId: 42, osUser: { a: 1 }, gitName: [], gitEmail: 'ok@x.com' });

    const row = await keyRow(token);
    expect(row.installation_id).toBeNull();
    expect(row.os_user).toBeNull();
    expect(row.git_name).toBeNull();
    expect(row.git_email).toBe('ok@x.com');
  });

  it('shows the approving admin whose machine it is', async () => {
    const start = await supertest(app).post('/hub/device/start').send({ installation: IDENTITY });

    const r = await supertest(app).post('/hub/device/approve')
      .set('Cookie', cookie).send({ userCode: start.body.userCode });

    // Approving a bare code tells an admin nothing about what they just let in.
    expect(r.body.installation).toMatchObject({
      installationId: 'inst-device-1',
      gitEmail: 'guilherme@cglab.com',
    });
  });

  it('does not leak one pending code identity into another', async () => {
    const a = await supertest(app).post('/hub/device/start').send({ installation: IDENTITY });
    const b = await supertest(app).post('/hub/device/start').send({
      installation: { ...IDENTITY, installationId: 'inst-device-2', gitEmail: 'other@cglab.com' },
    });
    await supertest(app).post('/hub/device/approve').set('Cookie', cookie).send({ userCode: b.body.userCode });
    const pollB = await supertest(app).post('/hub/device/poll').send({ deviceCode: b.body.deviceCode });
    await supertest(app).post('/hub/device/approve').set('Cookie', cookie).send({ userCode: a.body.userCode });
    const pollA = await supertest(app).post('/hub/device/poll').send({ deviceCode: a.body.deviceCode });

    expect((await keyRow(pollB.body.token)).installation_id).toBe('inst-device-2');
    expect((await keyRow(pollA.body.token)).installation_id).toBe('inst-device-1');
  });
});
