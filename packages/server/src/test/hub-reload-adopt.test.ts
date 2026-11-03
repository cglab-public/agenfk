/**
 * GH-346 review: POST /internal/hub/reload and a repoint now share one
 * adoptHubConfig(). Adopting a new hub configuration must also drop what the
 * old one decided for Airlock (GH-294): the dataset switch goes off until the
 * hub now in charge says otherwise. Nothing else pinned this; a mutant that
 * skipped the invalidation survived the whole hub suite.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

const TEST_DB = testDbPath('hub-reload-adopt-test-db.sqlite');
const ENV_KEYS = ['AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG', 'AGENFK_DB_PATH'];
const savedEnv: Record<string, string | undefined> = {};

const policy = {
  schemaVersion: 1, mode: 'observe', models: [], appliesWhenModelUnknown: true,
  hosts: { allow: ['github.com'], deny: [] },
  iocHosts: { revision: '0', hosts: [], updatedAt: null },
  rules: { uploadToUnlistedHost: 'deny', credentialReadWithNetwork: 'deny', namespaceEscape: 'deny', cloudMutation: 'needs-human-approval' },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, initStorage: any, closeStorage: any, VERIFY_TOKEN: string;
let server: import('http').Server;

describe('POST /internal/hub/reload adopts the new configuration whole (GH-346)', () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.AGENFK_HUB_URL = 'http://hub.example.test';
    process.env.AGENFK_HUB_TOKEN = 'agk_before';
    process.env.AGENFK_HUB_ORG = 'org-reload';
    process.env.AGENFK_DB_PATH = TEST_DB;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/v1/airlock/policy')) {
        return {
          status: 200, ok: true,
          headers: { get: (k: string) => (k.toLowerCase() === 'etag' ? 'W/"4:0:d1"' : null) },
          json: async () => ({ policy, revision: 4, iocRevision: 0, dataset: { enabled: true } }),
        };
      }
      return { status: 204, ok: true, headers: { get: () => null }, json: async () => ({}) };
    }));
    await removeTestDb(TEST_DB);
    ({ app, initStorage, closeStorage, VERIFY_TOKEN } = await import('../server'));
    server = app.listen(0);
    await initStorage();
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await removeTestDb(TEST_DB, closeStorage);
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
  });

  it('a rotated token switches the Airlock dataset off until the hub says again', async () => {
    const on = await request(server).get('/airlock/dataset?refresh=1');
    expect(on.body).toEqual({ joined: true, enabled: true });

    process.env.AGENFK_HUB_TOKEN = 'agk_after';
    const reload = await request(server).post('/internal/hub/reload').set('x-agenfk-internal', VERIFY_TOKEN).send({});
    expect(reload.body.changed).toBe(true);

    const off = await request(server).get('/airlock/dataset');
    expect(off.body).toEqual({ joined: true, enabled: false });
  });
});
