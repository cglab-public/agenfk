/**
 * GH-346, end to end: the server's own hub wiring. A hub that accepts the flow
 * requests and never answers them (what a target being drained mid-deploy looks
 * like) must not keep a new Airlock revision from being applied, and every
 * channel must ask the hub in the same tick.
 *
 * The hub here is a real HTTP server on loopback, so the requests go through
 * the server's real transport (hubFetch and the flusher's client), not a stub.
 * AGENFK_TEST_ENABLE_HUB lets initStorage start the hub machinery under vitest.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';

const TEST_DB = testDbPath('hub-sync-loop-server-test-db.sqlite');
const ENV_KEYS = [
  'AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG', 'AGENFK_DB_PATH',
  'AGENFK_TEST_ENABLE_HUB', 'AGENFK_HUB_SYNC_FIRST_DELAY_MS', 'AGENFK_HUB_SYNC_INTERVAL_MS',
];
const savedEnv: Record<string, string | undefined> = {};

const policy = {
  schemaVersion: 1, mode: 'observe', models: [], appliesWhenModelUnknown: true,
  hosts: { allow: ['github.com'], deny: [], allowDownload: ['*'] },
  iocHosts: { revision: '0', hosts: [], updatedAt: null },
  rules: { uploadToUnlistedHost: 'deny', credentialReadWithNetwork: 'deny', namespaceEscape: 'deny', cloudMutation: 'needs-human-approval' },
};

let hub: http.Server;
const sockets = new Set<import('net').Socket>();
const asked: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, initStorage: any, closeStorage: any, storage: any;
let server: http.Server;

describe('server hub loop (GH-346)', () => {
  beforeAll(async () => {
    hub = http.createServer((req, res) => {
      const url = req.url ?? '';
      asked.push(url.split('?')[0]);
      if (url.startsWith('/v1/flows')) return; // never answered
      if (url.startsWith('/v1/airlock/policy')) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('ETag', 'W/"11:0:d0"');
        return res.end(JSON.stringify({ policy, revision: 11, iocRevision: 0, dataset: { enabled: false } }));
      }
      if (url.startsWith('/v1/events')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ accepted: 0, rejected: [] }));
      }
      res.statusCode = 204;
      res.end();
    });
    hub.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.AGENFK_HUB_URL = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
    process.env.AGENFK_HUB_TOKEN = 'agk_test';
    process.env.AGENFK_HUB_ORG = 'org-test';
    process.env.AGENFK_DB_PATH = TEST_DB;
    process.env.AGENFK_TEST_ENABLE_HUB = '1';
    process.env.AGENFK_HUB_SYNC_FIRST_DELAY_MS = '0';
    process.env.AGENFK_HUB_SYNC_INTERVAL_MS = '3600000';
    await removeTestDb(TEST_DB);

    ({ app, initStorage, closeStorage, storage } = await import('../server'));
    server = app.listen(0);
    await initStorage();
    await (await import('../server')).storage.createProject({ id: 'p1', name: 'p1', description: '', createdAt: new Date(), updatedAt: new Date() });
    // Start again with the project on disk, so the first tick has a project's flow to ask for.
    await closeStorage();
    await initStorage();
    storage = (await import('../server')).storage;
  });

  afterAll(async () => {
    await removeTestDb(TEST_DB, closeStorage);
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => hub.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('applies the hub Airlock revision while the flow requests hang', async () => {
    let revision: number | undefined;
    for (let i = 0; i < 300; i++) {
      revision = (await storage.getAirlockPolicy('hub'))?.revision;
      if (revision === 11 && asked.includes('/v1/upgrade-directive')) break;
      await new Promise(r => setTimeout(r, 10));
    }
    expect(revision).toBe(11);
  });

  it('asks the hub on every pull channel from the one loop', () => {
    expect(asked).toContain('/v1/airlock/policy');
    expect(asked).toContain('/v1/upgrade-directive');
    expect(asked.some(u => u.startsWith('/v1/flows'))).toBe(true);
    expect(asked).toContain('/v1/repoint-directive');
  });
});
