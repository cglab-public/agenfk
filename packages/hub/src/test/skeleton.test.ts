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
});
