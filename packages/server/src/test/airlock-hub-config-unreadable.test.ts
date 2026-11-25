/**
 * An unreadable hub.json is not a logout (GH-294, T3 review).
 *
 * Only a confirmed absence of hub.json (and no AGENFK_HUB_* override) means
 * this installation left its hub. A file that exists but cannot be read or
 * parsed is a fault, and a fault must not hand the Airlock policy to whoever
 * runs on this machine: the hub row stays, and with it the hub's ownership.
 *
 * `hubConfigFileState` tells the cases apart; the server start is checked with
 * a hub row seeded and a corrupt hub.json in place.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { normalizeAirlockPolicy } from '@agenfk/core';
import { hubConfigFileState, hubConfigPath } from '../hub/hubClient';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('airlock-hub-config-unreadable-test-db.sqlite');
const ENV_KEYS = ['AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG', 'AGENFK_DB_PATH'];
const savedEnv: Record<string, string | undefined> = {};
let savedHubJson: string | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let __server: import('http').Server;

const writeHubJson = (text: string) => {
  fs.mkdirSync(path.dirname(hubConfigPath()), { recursive: true });
  fs.writeFileSync(hubConfigPath(), text);
};

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.AGENFK_HUB_URL;
  delete process.env.AGENFK_HUB_TOKEN;
  delete process.env.AGENFK_HUB_ORG;
  process.env.AGENFK_DB_PATH = TEST_DB;
  savedHubJson = fs.existsSync(hubConfigPath()) ? fs.readFileSync(hubConfigPath(), 'utf8') : null;
  await removeTestDb(TEST_DB);

  const seed = new SQLiteStorageProvider();
  await seed.init({ path: TEST_DB });
  await seed.putAirlockPolicy({
    scope: 'hub', revision: 9,
    policy: normalizeAirlockPolicy({ mode: 'enforce' }),
    updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'hub http://hub.invalid org org-a', authority: 'hub', etag: 'W/"9:0"',
  }, 0);
  await seed.shutdown();

  writeHubJson('{ this is not json');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests'); }));
  server = await import('../server');
  await server.initStorage();
  __server = server.app.listen(0);
});

afterAll(async () => {
  await new Promise<void>(r => __server.close(() => r()));
  await removeTestDb(TEST_DB, server.closeStorage);
  vi.unstubAllGlobals();
  if (savedHubJson === null) fs.rmSync(hubConfigPath(), { force: true });
  else fs.writeFileSync(hubConfigPath(), savedHubJson);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('hubConfigFileState', () => {
  it('absent when there is no hub.json', () => {
    const keep = fs.readFileSync(hubConfigPath(), 'utf8');
    fs.rmSync(hubConfigPath());
    try {
      expect(hubConfigFileState()).toBe('absent');
    } finally {
      writeHubJson(keep);
    }
  });

  it('unreadable when hub.json is not JSON, or lacks its fields', () => {
    expect(hubConfigFileState()).toBe('unreadable');
    const keep = fs.readFileSync(hubConfigPath(), 'utf8');
    try {
      writeHubJson(JSON.stringify({ url: 'http://hub' }));
      expect(hubConfigFileState()).toBe('unreadable');
    } finally {
      writeHubJson(keep);
    }
  });

  it('present when hub.json holds a config', () => {
    const keep = fs.readFileSync(hubConfigPath(), 'utf8');
    try {
      writeHubJson(JSON.stringify({ url: 'http://hub', token: 't', orgId: 'o' }));
      expect(hubConfigFileState()).toBe('present');
    } finally {
      writeHubJson(keep);
    }
  });
});

describe('a start with an unreadable hub.json', () => {
  it('keeps the hub row: it is not taken for leaving the hub', async () => {
    expect((await server.storage.getAirlockPolicy('hub'))?.revision).toBe(9);
    expect(await server.storage.getAirlockPolicy('local')).toBeNull();
  });

  it('the policy stays hub-managed, so a local write is still refused', async () => {
    const res = await request(__server).put('/airlock/policy').send({ policy: { mode: 'off' }, expectedRevision: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('HUB_OWNS_AIRLOCK_POLICY');
  });
});
