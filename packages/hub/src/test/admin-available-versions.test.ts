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
import { drainApp } from './helpers/drainApp';
import { createPasswordUser } from '../auth/password';
import { __resetAgenfkReleaseCache, __setReleaseFetcher } from '../services/githubReleases';

/**
 * A REAL listening server, so drainApp has something to drain (BUG 2bd7ee36).
 *
 * `drainApp` calls closeIdleConnections/closeAllConnections, which exist on
 * http.Server and NOT on an Express app — and `createHubApp` returns an
 * Express app. With `?.` those calls vanished silently, so the helper written
 * to fix this suite's flakiness never did anything. Module scope because a
 * file can hold several describes, each reassigning `app`.
 */
let __server: any;

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
    if (__server) await new Promise<void>(r => __server.close(() => r()));
    __server = app.listen(0);
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(__server).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookieAdmin = login.headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => {
    // Drain in-flight responses before closing the DB — see helpers/drainApp.ts
    await drainApp(__server);
    await ctx.db.close();
    cleanup();
    __resetAgenfkReleaseCache();
    __setReleaseFetcher(null);
  });

  it('returns full release list (newest → oldest) with fleetFloor=null when no installation has reported a version', async () => {
    await seedInstallation(ctx.db, 'org-a', 'inst-1', null);
    const r = await supertest(__server).get('/v1/admin/upgrade/available-versions').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body.fleetFloor).toBeNull();
    expect(r.body.versions).toEqual(['0.4.1', '0.4.0', '0.3.0-beta.23', '0.3.0-beta.22', '0.2.28', '0.2.10']);
  });

  it('filters releases below the fleet floor and sorts newest → oldest', async () => {
    // Mixed fleet — oldest reported version is 0.3.0-beta.22.
    await seedInstallation(ctx.db, 'org-a', 'inst-1', '0.4.0');
    await seedInstallation(ctx.db, 'org-a', 'inst-2', '0.3.0-beta.22');
    await seedInstallation(ctx.db, 'org-a', 'inst-3', '0.4.1');

    const r = await supertest(__server).get('/v1/admin/upgrade/available-versions').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body.fleetFloor).toBe('0.3.0-beta.22');
    // 0.2.28 and 0.2.10 are below the floor and excluded.
    expect(r.body.versions).toEqual(['0.4.1', '0.4.0', '0.3.0-beta.23', '0.3.0-beta.22']);
  });

  it('?unfiltered=1 offers every release, below the fleet floor too — a group upgrade targets child hubs the parent floor knows nothing about', async () => {
    await seedInstallation(ctx.db, 'org-a', 'inst-1', '0.4.1');

    const floored = await supertest(__server).get('/v1/admin/upgrade/available-versions').set('Cookie', cookieAdmin);
    expect(floored.body.versions).toEqual(['0.4.1']);

    const r = await supertest(__server).get('/v1/admin/upgrade/available-versions?unfiltered=1').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body.fleetFloor).toBeNull();
    expect(r.body.versions).toEqual(['0.4.1', '0.4.0', '0.3.0-beta.23', '0.3.0-beta.22', '0.2.28', '0.2.10']);
  });

  it('isolates fleet floor by org', async () => {
    await seedInstallation(ctx.db, 'org-a', 'inst-1', '0.4.0');
    await seedInstallation(ctx.db, 'org-b', 'inst-2', '0.2.10');

    const r = await supertest(__server).get('/v1/admin/upgrade/available-versions').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    // Only org-a's floor matters — org-b's older version must not pull the floor down.
    expect(r.body.fleetFloor).toBe('0.4.0');
    expect(r.body.versions).toEqual(['0.4.1', '0.4.0']);
  });

  it('returns 503 when there is no cache and GitHub is unreachable', async () => {
    __resetAgenfkReleaseCache();
    __setReleaseFetcher(async () => { throw new Error('network down'); });

    await seedInstallation(ctx.db, 'org-a', 'inst-1', '0.3.0-beta.22');

    const r = await supertest(__server).get('/v1/admin/upgrade/available-versions').set('Cookie', cookieAdmin);
    expect(r.status).toBe(503);
    expect(r.body.error).toBeTruthy();
  });

  it('rejects unauthenticated callers', async () => {
    const r = await supertest(__server).get('/v1/admin/upgrade/available-versions');
    expect(r.status).toBe(401);
  });

  it('?refresh=1 invalidates the cache and fetches a fresh release list', async () => {
    // Cache is primed by beforeEach with the default FAKE_RELEASES.
    await seedInstallation(ctx.db, 'org-a', 'inst-1', null);
    const before = await supertest(__server).get('/v1/admin/upgrade/available-versions').set('Cookie', cookieAdmin);
    expect(before.body.versions).toContain('0.4.1');
    expect(before.body.versions).not.toContain('0.5.0');

    // Now a new release was cut on GitHub. Without refresh, the cache still
    // serves the old list. With refresh=1, the route re-fetches.
    stubReleases([{ tag_name: 'v0.5.0' }, ...FAKE_RELEASES]);

    const stale = await supertest(__server).get('/v1/admin/upgrade/available-versions').set('Cookie', cookieAdmin);
    expect(stale.body.versions).not.toContain('0.5.0'); // cache hit

    const fresh = await supertest(__server).get('/v1/admin/upgrade/available-versions?refresh=1').set('Cookie', cookieAdmin);
    expect(fresh.body.versions[0]).toBe('0.5.0');
  });
});
