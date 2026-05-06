/**
 * GET /v1/admin/upgrade/available-versions
 *
 * Returns the list of versions the admin can target, sourced from the
 * public agenfk GitHub release list and filtered to versions >= the org's
 * fleet floor (the oldest agenfk_version reported by any installation).
 * Sorted newest → oldest.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { __resetAgenfkReleaseCache, __setReleaseFetcher } from '../services/githubReleases';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-available-versions-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const FAKE_RELEASES = [
  { tag_name: 'v0.4.1' },
  { tag_name: 'v0.4.0' },
  { tag_name: '0.3.0-beta.23' },
  { tag_name: '0.3.0-beta.22' },
  { tag_name: 'v0.2.28' },
  { tag_name: 'v0.2.10' },
];

function stubReleases(releases = FAKE_RELEASES) {
  __setReleaseFetcher(async () => ({ ok: true, status: 200, json: async () => releases } as any));
}

async function seedInstallation(db: any, orgId: string, id: string, version: string | null) {
  await db.run(
    `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, agenfk_version, agenfk_version_updated_at)
     VALUES (?, ?, '2026-05-01T10:00:00Z', '2026-05-01T10:00:00Z', 'tester', ?, ?)`,
    [id, orgId, version, version ? '2026-05-01T10:00:00Z' : null],
  );
}

describe('GET /v1/admin/upgrade/available-versions', () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;

  beforeEach(async () => {
    cleanup();
    __resetAgenfkReleaseCache();
    stubReleases();
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
    cookieAdmin = login.headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => {
    await ctx.db.close();
    cleanup();
    __resetAgenfkReleaseCache();
    __setReleaseFetcher(null);
  });

  it('returns full release list (newest → oldest) with fleetFloor=null when no installation has reported a version', async () => {
    await seedInstallation(ctx.db, 'org-a', 'inst-1', null);
    const r = await supertest(app).get('/v1/admin/upgrade/available-versions').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body.fleetFloor).toBeNull();
    expect(r.body.versions).toEqual(['0.4.1', '0.4.0', '0.3.0-beta.23', '0.3.0-beta.22', '0.2.28', '0.2.10']);
  });

  it('filters releases below the fleet floor and sorts newest → oldest', async () => {
    // Mixed fleet — oldest reported version is 0.3.0-beta.22.
    await seedInstallation(ctx.db, 'org-a', 'inst-1', '0.4.0');
    await seedInstallation(ctx.db, 'org-a', 'inst-2', '0.3.0-beta.22');
    await seedInstallation(ctx.db, 'org-a', 'inst-3', '0.4.1');

    const r = await supertest(app).get('/v1/admin/upgrade/available-versions').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body.fleetFloor).toBe('0.3.0-beta.22');
    // 0.2.28 and 0.2.10 are below the floor and excluded.
    expect(r.body.versions).toEqual(['0.4.1', '0.4.0', '0.3.0-beta.23', '0.3.0-beta.22']);
  });

  it('isolates fleet floor by org', async () => {
    await seedInstallation(ctx.db, 'org-a', 'inst-1', '0.4.0');
    await seedInstallation(ctx.db, 'org-b', 'inst-2', '0.2.10');

    const r = await supertest(app).get('/v1/admin/upgrade/available-versions').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    // Only org-a's floor matters — org-b's older version must not pull the floor down.
    expect(r.body.fleetFloor).toBe('0.4.0');
    expect(r.body.versions).toEqual(['0.4.1', '0.4.0']);
  });

  it('returns 503 when there is no cache and GitHub is unreachable', async () => {
    __resetAgenfkReleaseCache();
    __setReleaseFetcher(async () => { throw new Error('network down'); });

    await seedInstallation(ctx.db, 'org-a', 'inst-1', '0.3.0-beta.22');

    const r = await supertest(app).get('/v1/admin/upgrade/available-versions').set('Cookie', cookieAdmin);
    expect(r.status).toBe(503);
    expect(r.body.error).toBeTruthy();
  });

  it('rejects unauthenticated callers', async () => {
    const r = await supertest(app).get('/v1/admin/upgrade/available-versions');
    expect(r.status).toBe(401);
  });
});
