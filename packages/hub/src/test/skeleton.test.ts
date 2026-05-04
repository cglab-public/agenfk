import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHubApp } from '../server';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-skel-test-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('createHubApp', () => {
  let teardown: () => void = () => {};

  beforeEach(() => cleanup());
  afterEach(() => { teardown(); cleanup(); });

  it('initializes schema and seeds default org+auth_config', () => {
    const { ctx } = createHubApp({
      dbPath: TEST_DB,
      secretKey: '0'.repeat(64),
      sessionSecret: 'sess',
      defaultOrgId: 'acme',
    });
    teardown = () => ctx.db.close();

    const tables = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map(t => t.name);
    for (const expected of ['orgs', 'api_keys', 'installations', 'events', 'rollups_daily', 'users', 'auth_config']) {
      expect(names).toContain(expected);
    }

    const org = ctx.db.prepare('SELECT id FROM orgs').get() as { id: string };
    expect(org.id).toBe('acme');

    const cfg = ctx.db.prepare('SELECT password_enabled FROM auth_config WHERE org_id = ?').get('acme') as { password_enabled: number };
    expect(cfg.password_enabled).toBe(1);
  });

  it('healthz returns ok', async () => {
    const { app, ctx } = createHubApp({
      dbPath: TEST_DB,
      secretKey: '0'.repeat(64),
      sessionSecret: 'sess',
      defaultOrgId: 'org',
    });
    teardown = () => ctx.db.close();

    // Use http via supertest for a clean assertion
    const supertest = (await import('supertest')).default;
    const res = await supertest(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('openDb migrates a legacy events table without item_type/remote_url columns', async () => {
    // Simulate a pre-beta.9 DB: create the events table with the old shape
    // and call openDb(). The migration must add the missing columns + indexes
    // without throwing — the bug we're guarding against was that CREATE INDEX
    // on the new columns ran *before* ALTER TABLE.
    const { openDb } = await import('../db');
    cleanup();
    const legacy = openDb(TEST_DB);
    legacy.exec("DROP TABLE IF EXISTS events");
    legacy.exec(`
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        user_key TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        type TEXT NOT NULL,
        project_id TEXT,
        item_id TEXT,
        payload TEXT NOT NULL
      )
    `);
    legacy.close();

    // Re-open: this must not throw, even though the legacy table is missing
    // the item_type and remote_url columns referenced by the new indexes.
    const db = openDb(TEST_DB);
    teardown = () => { try { db.close(); } catch { /* already closed */ } };
    const cols = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c: any) => c.name));
    expect(names.has('item_type')).toBe(true);
    expect(names.has('remote_url')).toBe(true);
  });

  it('SPA fallback serves index.html for client-side routes (regression: refresh 404)', async () => {
    // The hub serves a React SPA from packages/hub-ui/dist via express.static
    // plus a catch-all that re-serves index.html for any non-API URL so that
    // hard-refreshing /users/foo, /admin/keys, /connect, etc. resolves to the
    // SPA shell rather than 404. This pins that fallback for both unencoded
    // and percent-encoded paths.
    const fs = await import('fs');
    const path = await import('path');
    const tmp = path.join(require('os').tmpdir(), `hub-ui-fixture-${process.pid}`);
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'index.html'), '<html data-test-spa="1"></html>', 'utf8');
    process.env.AGENFK_HUB_UI_DIR = tmp;

    const { app, ctx } = createHubApp({
      dbPath: TEST_DB,
      secretKey: '0'.repeat(64),
      sessionSecret: 'sess',
      defaultOrgId: 'org',
    });
    teardown = () => { try { ctx.db.close(); } catch { /* */ } delete process.env.AGENFK_HUB_UI_DIR; fs.rmSync(tmp, { recursive: true, force: true }); };

    const supertest = (await import('supertest')).default;
    for (const route of ['/users/alice%40acme.com', '/admin/keys', '/connect', '/anything/deep/here']) {
      const res = await supertest(app).get(route);
      expect(res.status, `route ${route} should serve SPA shell`).toBe(200);
      expect(res.text).toContain('data-test-spa');
    }
    // API prefixes must NOT be intercepted.
    const apiRes = await supertest(app).get('/v1/timeline');
    expect(apiRes.status).not.toBe(200); // some 4xx is fine; 200 with SPA HTML would mean we hijacked the API.
    expect(apiRes.text).not.toContain('data-test-spa');
  });

  it('healthz reports the live hub package version (not a hardcoded literal)', async () => {
    const { app, ctx } = createHubApp({
      dbPath: TEST_DB,
      secretKey: '0'.repeat(64),
      sessionSecret: 'sess',
      defaultOrgId: 'org',
    });
    teardown = () => ctx.db.close();

    const expectedVersion = (
      await import('fs')
    ).readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8');
    const expected = JSON.parse(expectedVersion).version;

    const supertest = (await import('supertest')).default;
    const res = await supertest(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(expected);
  });
});
