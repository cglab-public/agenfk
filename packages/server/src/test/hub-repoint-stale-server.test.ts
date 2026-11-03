/**
 * GH-346 review: a repoint run that is still verifying its target when a newer
 * hub configuration is adopted (a login or token rotation, through POST
 * /internal/hub/reload) must not finish the move with its older token. Before
 * the fence, the late run rewrote hub.json with the old token and adopted it on
 * every channel.
 *
 * Both transports are stubbed, as in hub-repoint-adopt-server.test.ts: a repoint
 * target must be https and public, so no local server can be the new hub.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';

const OLD = 'https://hub-a.example.test';
const NEW = 'https://hub-b.example.test';
const ORG = 'org-stale';

let releaseHealthz!: () => void;
const healthzHeld = new Promise<void>((r) => { releaseHealthz = r; });
let healthzAsked = false;

vi.mock('axios', async (importOriginal) => {
  const actual: any = await importOriginal();
  const answer = async (url: string) => {
    if (url === `${OLD}/v1/repoint-directive`) {
      return { status: 200, data: { campaignId: 'c-1', targetUrl: NEW, allowedHost: 'hub-b.example.test' } };
    }
    if (url === `${NEW}/healthz`) {
      healthzAsked = true;
      await healthzHeld; // the run waits here while the configuration changes
      return { status: 200, data: { service: 'agenfk-hub' } };
    }
    if (url === `${NEW}/v1/ping`) return { status: 200, data: { orgId: ORG } };
    return { status: 204, data: '' };
  };
  const create = vi.fn((cfg: any) => ({
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    get: vi.fn(async (p: string) => answer(`${String(cfg?.baseURL ?? '').replace(/\/$/, '')}${p}`)),
    post: vi.fn(async (_p: string, body: any) => ({ status: 200, data: { ingested: body?.events?.length ?? 0, skipped: 0, rejected: [] } })),
  }));
  return { ...actual, default: { ...actual.default, get: vi.fn(answer), create } };
});

const TEST_DB = testDbPath('hub-repoint-stale-server-test-db.sqlite');
const ENV_KEYS = [
  'AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG', 'AGENFK_DB_PATH',
  'AGENFK_TEST_ENABLE_HUB', 'AGENFK_HUB_SYNC_FIRST_DELAY_MS', 'AGENFK_HUB_SYNC_INTERVAL_MS',
];
const savedEnv: Record<string, string | undefined> = {};
const hubJson = path.join(os.homedir(), '.agenfk', 'hub.json');
let savedHubJson: string | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, closeStorage: any, VERIFY_TOKEN: string;
let server: import('http').Server;

describe('a repoint overtaken by a newer configuration (GH-346)', () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    delete process.env.AGENFK_HUB_URL;
    delete process.env.AGENFK_HUB_TOKEN;
    delete process.env.AGENFK_HUB_ORG;
    process.env.AGENFK_DB_PATH = TEST_DB;
    process.env.AGENFK_TEST_ENABLE_HUB = '1';
    process.env.AGENFK_HUB_SYNC_FIRST_DELAY_MS = '0';
    // One tick only: the run under test is the first tick's repoint.
    process.env.AGENFK_HUB_SYNC_INTERVAL_MS = '3600000';
    savedHubJson = fs.existsSync(hubJson) ? fs.readFileSync(hubJson, 'utf8') : null;
    fs.mkdirSync(path.dirname(hubJson), { recursive: true });
    fs.writeFileSync(hubJson, JSON.stringify({ url: OLD, token: 'agk_old', orgId: ORG }), { mode: 0o600 });
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404, ok: false, headers: { get: () => null }, json: async () => ({}) })));

    await removeTestDb(TEST_DB);
    let initStorage: any;
    ({ app, initStorage, closeStorage, VERIFY_TOKEN } = await import('../server'));
    server = app.listen(0);
    await initStorage();
  });

  afterAll(async () => {
    releaseHealthz();
    await new Promise<void>((r) => server.close(() => r()));
    await removeTestDb(TEST_DB, closeStorage);
    vi.unstubAllGlobals();
    if (savedHubJson === null) fs.rmSync(hubJson, { force: true });
    else fs.writeFileSync(hubJson, savedHubJson, { mode: 0o600 });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
  });

  it('the late run neither rewrites hub.json nor adopts its older token', async () => {
    for (let i = 0; i < 300 && !healthzAsked; i++) await new Promise(r => setTimeout(r, 10));
    expect(healthzAsked).toBe(true);

    // `agenfk hub login` issued a new token while the repoint was verifying.
    fs.writeFileSync(hubJson, JSON.stringify({ url: OLD, token: 'agk_new', orgId: ORG }), { mode: 0o600 });
    const reload = await request(server).post('/internal/hub/reload').set('x-agenfk-internal', VERIFY_TOKEN).send({});
    expect(reload.body.changed).toBe(true);

    releaseHealthz();
    await new Promise(r => setTimeout(r, 300));

    expect(JSON.parse(fs.readFileSync(hubJson, 'utf8'))).toEqual({ url: OLD, token: 'agk_new', orgId: ORG });
    // The live configuration is still the newer one: reloading the same hub.json changes nothing.
    const again = await request(server).post('/internal/hub/reload').set('x-agenfk-internal', VERIFY_TOKEN).send({});
    expect(again.body).toMatchObject({ changed: false, url: OLD, orgId: ORG });
  });
});
