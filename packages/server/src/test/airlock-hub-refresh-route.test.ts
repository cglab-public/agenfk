/**
 * GET /airlock/policy?refresh=1 on a hub-joined installation (GH-294, T3) pulls
 * the org's policy from the hub now, instead of waiting for the next flow-sync
 * tick, and answers with what it adopted. Without `refresh` the route only
 * reads what is stored.
 *
 * The hub config is forced through the environment before the server module is
 * imported, and fetch is stubbed: only the hub's airlock route answers.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('airlock-hub-refresh-route-test-db.sqlite');
const ENV_KEYS = ['AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG', 'AGENFK_DB_PATH'];
const savedEnv: Record<string, string | undefined> = {};

/** Exactly as the hub sends one: every field present (an incomplete answer is refused). */
const HUB_POLICY = {
  schemaVersion: 1, mode: 'enforce', models: [], appliesWhenModelUnknown: true,
  hosts: { allow: ['github.com'], deny: [] },
  iocHosts: { revision: '0', hosts: [], updatedAt: null },
  rules: { uploadToUnlistedHost: 'deny', credentialReadWithNetwork: 'deny', namespaceEscape: 'deny', cloudMutation: 'needs-human-approval' },
};
const fetchCalls: string[] = [];
/** The hub's dataset switch, as its next answer carries it. */
let hubDataset = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let __server: import('http').Server;
const agent = () => request(__server);

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.AGENFK_HUB_URL = 'http://hub.invalid';
  process.env.AGENFK_HUB_TOKEN = 'agk_test';
  process.env.AGENFK_HUB_ORG = 'org-airlock';
  process.env.AGENFK_DB_PATH = TEST_DB;
  await removeTestDb(TEST_DB);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetchCalls.push(String(url));
    if (String(url) === 'http://hub.invalid/v1/airlock/policy') {
      return {
        status: 200, ok: true,
        headers: { get: (k: string) => (k.toLowerCase() === 'etag' ? 'W/"5:0"' : null) },
        json: async () => ({ policy: HUB_POLICY, revision: 5, dataset: { enabled: hubDataset } }),
      };
    }
    throw new Error('no network in tests');
  }));
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

describe('GET /airlock/policy?refresh=1', () => {
  it('without refresh it reads only what is stored', async () => {
    const res = await agent().get('/airlock/policy');
    expect(res.status).toBe(200);
    expect(res.body.hub).toBeNull();
    expect(fetchCalls.filter(u => u.includes('/v1/airlock/policy'))).toHaveLength(0);
  });

  it('with refresh=1 it pulls the hub policy now and answers with it', async () => {
    const res = await agent().get('/airlock/policy?refresh=1');
    expect(res.status).toBe(200);
    expect(fetchCalls.filter(u => u.includes('/v1/airlock/policy'))).toHaveLength(1);
    expect(res.body.source).toBe('hub');
    expect(res.body.revision).toBe(5);
    expect(res.body.effective.mode).toBe('enforce');
    expect(res.body.effective.hosts.allow).toEqual(['github.com']);
  });
});

// BUG 4f2e0354: an admin flipped the dataset switch and this installation only saw it at its
// next 5-minute sync; `agenfk airlock dataset status` asks for the hub's word now.
describe('GET /airlock/dataset?refresh=1', () => {
  it('without refresh it answers what the last sync adopted; with refresh=1 it asks the hub now', async () => {
    await agent().get('/airlock/policy?refresh=1');
    hubDataset = true;
    const stale = await agent().get('/airlock/dataset');
    expect(stale.status).toBe(200);
    expect(stale.body).toEqual({ joined: true, enabled: false });

    const before = fetchCalls.filter(u => u.includes('/v1/airlock/policy')).length;
    const fresh = await agent().get('/airlock/dataset?refresh=1');
    expect(fresh.status).toBe(200);
    expect(fetchCalls.filter(u => u.includes('/v1/airlock/policy')).length).toBe(before + 1);
    expect(fresh.body).toEqual({ joined: true, enabled: true });
    hubDataset = false;
  });
});
