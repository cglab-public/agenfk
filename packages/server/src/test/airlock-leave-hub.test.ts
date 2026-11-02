/**
 * Leaving the hub keeps the Airlock policy in force (GH-294, T3).
 *
 * `agenfk hub logout` removes hub.json; the server notices at its next start
 * (or on /internal/hub/reload). An installation that holds a hub row but is no
 * longer joined copies that row to its local policy and drops the hub row, so
 * the protection the org set does not vanish with the link, and the person
 * can now edit it locally.
 *
 * The database is prepared with a hub row BEFORE the server module is imported
 * with no hub configured.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { normalizeAirlockPolicy } from '@agenfk/core';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('airlock-leave-hub-test-db.sqlite');
const ENV_KEYS = ['AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG', 'AGENFK_DB_PATH'];
const savedEnv: Record<string, string | undefined> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let __server: import('http').Server;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.AGENFK_HUB_URL;
  delete process.env.AGENFK_HUB_TOKEN;
  delete process.env.AGENFK_HUB_ORG;
  process.env.AGENFK_DB_PATH = TEST_DB;
  await removeTestDb(TEST_DB);

  const seed = new SQLiteStorageProvider();
  await seed.init({ path: TEST_DB });
  await seed.putAirlockPolicy({
    scope: 'hub', revision: 9,
    policy: normalizeAirlockPolicy({ mode: 'enforce', hosts: { allow: ['github.com'], deny: [] } }),
    updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'hub', authority: 'hub', etag: 'W/"9:0"',
  }, 0);
  await seed.shutdown();

  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests'); }));
  server = await import('../server');
  await server.initStorage();
  __server = server.app.listen(0);
});

afterAll(async () => {
  await new Promise<void>(r => __server.close(() => r()));
  await removeTestDb(TEST_DB, server.closeStorage);
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('a standalone start with a hub row left over', () => {
  it('has copied the hub policy to local and dropped the hub row', async () => {
    expect(await server.storage.getAirlockPolicy('hub')).toBeNull();
    const local = await server.storage.getAirlockPolicy('local');
    expect(local?.policy.mode).toBe('enforce');
    expect(local?.policy.hosts.allow).toEqual(['github.com']);
  });

  it('reports the policy as local and no longer hub-managed, so it can be edited', async () => {
    const res = await request(__server).get('/airlock/policy');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('local');
    expect(res.body.hubManaged).toBe(false);
    expect(res.body.effective.mode).toBe('enforce');
  });
});
